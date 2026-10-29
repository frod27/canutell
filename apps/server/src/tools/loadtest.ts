import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BotClient, POLICY_NAMES, type BotResult } from '@canutell/bots';
import {
  PostgresStore,
  answerAge,
  canonicalJson,
  createAccount,
  createSession,
  integrityApplies,
  setConsent,
  dbRevealSource,
  loadMatch,
  pgSql,
  revealFromDb,
  type MatchStore,
  type RevealSource,
  type Sql,
} from '@canutell/db';
import { hashJson, replay, viewFor } from '@canutell/engine';
import {
  MatchRevealResponseSchema,
  ModeSchema,
  type ClientEnv,
  type Mode,
  type ServerMessage,
  type TrustLevel,
} from '@canutell/protocol';
import type { PasskeyCeremonies } from '../accounts-api';
import { auditMatch, type Violation } from '@canutell/sim';
import { ScaledClock } from '../clock';
import { startGameServer } from '../server';
import { MemoryStore, type StoredMatch } from '../store';
import { BASELINE_AGENT_VERSION, agentServiceSeater, type AgentSeater } from '../agent-service';

// Phase 2 acceptance: real matches over real WebSockets, then an audit of everything the server logged.
//
//   pnpm loadtest --matches 200 --mode both --speed 60
//
// Every seat — humans (simulated by bots joining the public queue) and agent seats (spawned by the
// server) — is a BotClient talking the public protocol. Checks per match:
//   • the Phase 1 log audit (conservation, decisions, timeouts, pot, votes, exile, ballots, …)
//   • replay(config, seed, server input log) reproduces the server's event log byte for byte
//   • every non-timeout decision has a server-measured latency (CLAUDE.md invariant 6)
//   • no rejection other than `late` (bots only answer prompts they were shown)
//   • every frame a client received before Reveal is free of roles (CLAUDE.md invariant 7), and every
//     view frame is that client's own seat
//
// With --store postgres (needs DATABASE_URL, migrated), every write also goes to Postgres, and:
//   • the database log equals the in-memory log (events, inputs, timings, connections, rejections)
//   • the reveal rebuilt from derived tables equals the engine's reveal, for every match
//   • derived rows reconcile with the log
//   • GET /api/matches/:id/reveal answers a seated player correctly and refuses everyone else
//
// With --store postgres, half the simulated humans are passkey accounts (created directly in the
// database; the WebAuthn ceremony itself is covered by apps/web/e2e/accounts.mjs), at T1 or T2, some with
// research consent; half of those report a client environment like the web client. Checks (Phase 5):
//   • every human seat's trust_level_at_match is the account's level at match time, T0 for guests
//   • guests are stored under a fresh pseudonym per match, never the id their client knows
//   • integrity rows exist exactly for account seats and bot/agent seats; nothing at all for guests
//   • an account seat with no client environment is flagged no_client_signals (the detector catches
//     scripted clients) and its T2 player drops to T1; trust history matches
//   • the training pool is empty (every match is flagged phase5)
//   • no frame carries account data except the player's own welcome
//
// With --agents python, agent seats are played by the real Python agent service (services/agents), and:
//   • every agent seat was played by baseline-1 (no fallback)
//   • every non-timeout agent decision carries a confidence annotation; human seats never do
//   • every agent response took at least the human minimum, as measured by the server (invariant 14)
//   • every agent chat line passes the agent safety filter (invariant 13)

const ROLE_LEAK = /isAgent|agentVersion|agentCount|scripted-0|targetIsAgent/;

interface ClientLog {
  frames: ServerMessage[];
  result: BotResult | null;
}

function parse() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      matches: { type: 'string', default: '200' },
      mode: { type: 'string', default: 'both' },
      speed: { type: 'string', default: '60' },
      concurrency: { type: 'string', default: '100' },
      'timeout-pct': { type: 'string', default: '5' },
      store: { type: 'string', default: 'memory' },
      agents: { type: 'string', default: 'scripted' },
    },
  });
  if (values.agents !== 'scripted' && values.agents !== 'python')
    throw new Error('--agents must be scripted or python');
  if (values.store !== 'memory' && values.store !== 'postgres')
    throw new Error('--store must be memory or postgres');
  if (values.store === 'postgres' && !process.env.DATABASE_URL)
    throw new Error('--store postgres needs DATABASE_URL');
  return {
    matches: Number(values.matches),
    modes: (values.mode === 'both' ? ['full', 'quick'] : [ModeSchema.parse(values.mode)]) as Mode[],
    speed: Number(values.speed),
    concurrency: Number(values.concurrency),
    timeoutPct: Number(values['timeout-pct']),
    store: values.store as 'memory' | 'postgres',
    agents: values.agents as 'scripted' | 'python',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

async function runMode(mode: Mode, o: ReturnType<typeof parse>) {
  const store = new MemoryStore();
  const clock = new ScaledClock(o.speed);
  const clients: ClientLog[] = [];
  const pending: Promise<unknown>[] = [];
  let seq = 0;

  const launch = (url: string, token: string | null, queue: Mode | undefined, env?: ClientEnv) => {
    const log: ClientLog = { frames: [], result: null };
    clients.push(log);
    const bot = new BotClient({
      url,
      token,
      queue,
      policy: POLICY_NAMES[seq % POLICY_NAMES.length]!,
      seed: `lt-${mode}-${seq++}`,
      speed: o.speed,
      timeoutPct: o.timeoutPct,
      onFrame: (f) => log.frames.push(f),
      env,
    });
    pending.push(bot.run().then((r) => (log.result = r)));
    return bot;
  };

  let sql: Sql | null = null;
  let pg: PostgresStore | null = null;
  let reveals: RevealSource | undefined;
  const dbErrors: string[] = [];
  if (o.store === 'postgres') {
    sql = pgSql(process.env.DATABASE_URL!);
    pg = new PostgresStore(sql, { onError: (id, e) => dbErrors.push(`${id}: ${String(e)}`) });
    reveals = dbRevealSource(sql);
  }
  const agentService = o.agents === 'python' ? await startAgentService() : null;
  const server = await startGameServer({
    clock,
    accounts: sql ? { sql, ceremonies: NO_CEREMONIES } : undefined,
    store: pg ? tee(store, pg) : store,
    reveals,
    spawnBot: (args) => launch(args.url, args.token, undefined),
    agentSeater: agentService?.seater,
    formationDelayMs: 0, // throughput; the delay's own guarantee is tested in server.test.ts
  });

  const started = performance.now();
  const accounts = new Map<string, LoadAccount>();
  const humans: BotClient[] = [];
  const unseated = () => humans.filter((b) => b.seatedMatchId === null).length;
  while (server.stats().matchesStarted < o.matches) {
    // Keep at most one match's worth of humans waiting, and respect the concurrency cap.
    if (server.stats().matchesRunning >= o.concurrency || unseated() >= 6) {
      await sleep(10);
      continue;
    }
    if (sql && humans.length % 2 === 0) {
      const a = await makeAccount(sql, accounts.size);
      accounts.set(a.playerId, a);
      humans.push(launch(server.url, a.session, mode, a.env ? CLEAN_ENV : undefined));
    } else humans.push(launch(server.url, null, mode));
    await sleep(2);
  }
  // Humans still waiting in the queue after the last match formed are released.
  await sleep(200);
  for (const b of humans) if (b.seatedMatchId === null) b.close();
  while (server.stats().matchesRunning > 0) await sleep(50);
  await Promise.allSettled(pending);
  const seconds = (performance.now() - started) / 1000;

  const violations: Violation[] = [];
  const fail = (check: string, detail: string) => violations.push({ check, detail });
  if (pg) {
    await pg.drain();
    await auditRevealEndpoint(server.url, store, clients, fail);
  }
  await server.close();
  agentService?.stop();

  // ---------- audit ----------
  const latencies: number[] = [];
  const rejections: Record<string, number> = {};
  let decisions = 0;
  let timeouts = 0;

  for (const m of store.matches.values()) {
    auditStored(m, fail);
    for (const r of m.rejections) rejections[r.code] = (rejections[r.code] ?? 0) + 1;
    for (const t of m.timings) {
      decisions++;
      if (t.timedOut) timeouts++;
      else if (t.latencyMs !== null) latencies.push(t.latencyMs);
    }
  }
  for (const c of clients) auditFrames(c, fail);
  if (o.agents === 'python') await auditAgents([...store.matches.values()], fail);
  if (sql) {
    for (const e of dbErrors) fail('db_write', e);
    for (const m of store.matches.values()) await auditDatabase(sql, m, fail);
    await auditAccounts(sql, [...store.matches.values()], clients, accounts, fail);
    await sql.close();
  }

  return {
    mode,
    matches: store.matches.size,
    seconds,
    decisions,
    timeouts,
    latencies,
    rejections,
    violations,
    clients: clients.filter((c) => c.result?.matchId).length,
  };
}

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/agents');
/** Never faster than this, as measured by the server (services/agents timing.py MIN_REACTION_MS). */
const AGENT_MIN_REACTION_MS = 1_200;

/** Start the real Python agent service on a free port. */
async function startAgentService(): Promise<{ seater: AgentSeater; stop: () => void }> {
  const secret = randomBytes(16).toString('hex');
  const child: ChildProcess = spawn('uv', ['run', '--quiet', 'python', '-m', 'canutell_agents'], {
    cwd: AGENTS_DIR,
    env: { ...process.env, AGENT_SERVICE_SECRET: secret, AGENT_PORT: '0', AGENT_LOG_LEVEL: 'WARNING' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((ok, fail) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const m = /^AGENT_SERVICE_LISTENING (\d+)$/.exec(line.trim());
      if (m) ok(Number(m[1]));
    });
    child.on('exit', (code) => fail(new Error(`agent service exited with ${code}`)));
  });
  return {
    seater: agentServiceSeater({ url: `http://127.0.0.1:${port}`, secret, timeoutMs: 5_000 }),
    stop: () => child.kill('SIGTERM'),
  };
}

/** CLAUDE.md invariants 13–15, checked from what the server recorded. */
async function auditAgents(
  matches: StoredMatch[],
  fail: (check: string, detail: string) => void,
): Promise<void> {
  const chat: string[] = [];
  for (const m of matches) {
    const id = m.meta.matchId;
    const agentSeats = new Set(m.meta.config.seats.filter((s) => s.isAgent).map((s) => s.seatId));
    for (const s of m.meta.config.seats) {
      if (s.isAgent && s.agentVersion !== BASELINE_AGENT_VERSION)
        fail('agent_version', `${id} seat ${s.seatId}: ${s.agentVersion}`);
    }
    if (m.meta.flags.includes('agent_fallback')) fail('agent_fallback', id);
    const annotated = new Map(m.annotations.map((a) => [a.seq, a]));
    for (const e of m.events) {
      if (e.type === 'chat_message' && agentSeats.has(e.seat!)) chat.push(e.payload.text);
      if (e.type !== 'decision') continue;
      const a = annotated.get(e.seq);
      if (!agentSeats.has(e.seat!)) {
        if (a) fail('annotation_on_human', `${id} seq ${e.seq}`);
        continue;
      }
      if (!e.payload.timedOut && (!a || a.confidence < 0 || a.confidence > 100))
        fail('agent_confidence', `${id} seq ${e.seq}`);
    }
    for (const t of m.timings) {
      if (
        agentSeats.has(t.seat) &&
        !t.timedOut &&
        t.latencyMs !== null &&
        t.latencyMs < AGENT_MIN_REACTION_MS - 100
      )
        fail('agent_too_fast', `${id} seq ${t.seq}: ${t.latencyMs} ms`);
    }
  }
  agentChecks.chatLines = chat.length;
  // The Python safety filter is the source of truth; run it over every agent line.
  const child = spawn('uv', ['run', '--quiet', 'python', '-m', 'canutell_agents.safety'], {
    cwd: AGENTS_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stdin.end(chat.map((text) => JSON.stringify({ text })).join('\n') + '\n');
  await new Promise((r) => child.on('close', r));
  for (const line of out.split('\n').filter(Boolean)) fail('agent_chat_unsafe', line);
}

const agentChecks = { chatLines: 0, decisions: 0 };

/** Writes every record to both stores (the load test compares them). */
function tee(a: MatchStore, b: MatchStore): MatchStore {
  return {
    open: (m) => (a.open(m), b.open(m)),
    events: (id, e) => (a.events(id, e), b.events(id, e)),
    input: (id, i) => (a.input(id, i), b.input(id, i)),
    timing: (id, r) => (a.timing(id, r), b.timing(id, r)),
    connection: (id, r) => (a.connection(id, r), b.connection(id, r)),
    rejection: (id, r) => (a.rejection(id, r), b.rejection(id, r)),
    annotation: (id, r) => (a.annotation(id, r), b.annotation(id, r)),
    clientSignal: (id, r) => (a.clientSignal(id, r), b.clientSignal(id, r)),
    close: (id, st, at) => (a.close(id, st, at), b.close(id, st, at)),
    shutdown: async () => {
      await a.shutdown();
      await b.shutdown();
    },
  };
}

/** The database must hold exactly what the server logged, and its derived reveal must equal the engine's. */
const dbChecks = { matches: 0, httpReveals: 0, httpRefusals: 0 };

async function auditDatabase(
  sql: Sql,
  m: StoredMatch,
  fail: (check: string, detail: string) => void,
): Promise<void> {
  const id = m.meta.matchId;
  dbChecks.matches++;
  const db = await loadMatch(sql, id);
  if (!db) return fail('db_missing', id);
  if (db.status !== m.meta.status) fail('db_status', `${id}: ${db.status} vs ${m.meta.status}`);
  const same = (what: string, a: unknown, b: unknown) => {
    if (canonicalJson(a) !== canonicalJson(b))
      fail(`db_${what}`, `${id}: database ${what} differ from the server log`);
  };
  same('events', db.events, m.events);
  same('inputs', db.inputs, m.inputs);
  same('timings', db.timings, m.timings);
  same('connections', db.connections, m.connections);
  same('rejections', db.rejections, m.rejections);
  same('annotations', db.annotations, m.annotations);
  same('client_signals', db.clientSignals, m.clientSignals);
  const state = replay(m.meta.config, m.meta.seed, m.inputs).state;
  same('reveal', await revealFromDb(sql, id), viewFor(state, 0).reveal);
  const [row] = await sql.query<{ n: number }>(
    'select count(*)::int as n from decisions where match_id = $1',
    [id],
  );
  if (row?.n !== m.events.filter((e) => e.type === 'decision').length)
    fail('db_derived', `${id}: decision rows ≠ decision events`);
}

// ---------- Phase 5: accounts, trust, integrity ----------

/** Accounts here are made in the database; no WebAuthn ceremony is ever run by the load test. */
const NO_CEREMONIES: PasskeyCeremonies = {
  registrationOptions: () => Promise.reject(new Error('not in load tests')),
  verifyRegistration: async () => null,
  authenticationOptions: () => Promise.reject(new Error('not in load tests')),
  verifyAuthentication: async () => null,
};
const CLEAN_ENV: ClientEnv = {
  webdriver: false,
  headlessUserAgent: false,
  noLanguages: false,
  zeroOuterSize: false,
};

interface LoadAccount {
  playerId: string;
  session: string;
  trust: TrustLevel;
  env: boolean;
}

/** Account i: T1, T2, or T2 with research consent (cycling); half report a client environment. */
async function makeAccount(sql: Sql, i: number): Promise<LoadAccount> {
  const now = Date.now();
  const playerId = await createAccount(sql, {
    userHandle: randomBytes(32),
    passkey: {
      credentialId: randomBytes(16).toString('base64url'),
      publicKey: randomBytes(65),
      signCount: 0,
      transports: [],
      multiDevice: false,
      backedUp: false,
    },
    termsVersion: 1,
    now,
  });
  let trust: TrustLevel = 'T1';
  if (i % 3 !== 0) trust = (await answerAge(sql, playerId, { year: 1990, month: 1, now })).trustLevel;
  if (i % 3 === 2) await setConsent(sql, playerId, 'research', true, now);
  return {
    playerId,
    session: await createSession(sql, playerId, now),
    trust,
    env: Math.floor(i / 3) % 2 === 0,
  };
}

const accountChecks = { accounts: 0, accountSeats: 0, guestSeats: 0, flaggedSeats: 0, lowered: 0 };
const lower = (t: TrustLevel): TrustLevel => (t === 'T3' ? 'T2' : t === 'T2' ? 'T1' : t);

async function auditAccounts(
  sql: Sql,
  matches: StoredMatch[],
  clients: ClientLog[],
  accounts: Map<string, LoadAccount>,
  fail: (check: string, detail: string) => void,
): Promise<void> {
  accountChecks.accounts += accounts.size;
  const known = new Set<string>();
  for (const c of clients) {
    for (const f of c.frames) {
      if (f.type === 'welcome') {
        known.add(f.playerId);
        if ((f.account !== null) !== accounts.has(f.playerId))
          fail('welcome_account', `${f.playerId}: account ${f.account ? 'present' : 'missing'}`);
      } else if (/trustLevel|ageConfirmed|researchConsent/.test(JSON.stringify(f)))
        fail('account_leak', `${f.type} frame carries account data`);
    }
  }
  const guestIds = new Set<string>();
  const played = new Map<string, boolean>(); // account → flagged in its match
  for (const m of matches) {
    const id = m.meta.matchId;
    const rows = await sql.query<{ seat_id: number; signal: string; flagged: boolean }>(
      'select seat_id, signal, flagged from integrity_signals where match_id = $1',
      [id],
    );
    const signals = await sql.query<{ seat_id: number }>(
      'select distinct seat_id from client_signals where match_id = $1',
      [id],
    );
    for (const o of m.meta.occupants) {
      const seatRows = rows.filter((r) => r.seat_id === o.seat);
      const expected = integrityApplies({
        seat: o.seat,
        kind: o.kind,
        trustLevel: o.kind === 'human' ? (o.trustLevel ?? 'T0') : null,
      });
      if (expected !== seatRows.length > 0)
        fail('integrity_rows', `${id} seat ${o.seat}: rows ${seatRows.length}`);
      if (o.kind !== 'human') continue;
      const account = accounts.get(o.playerId);
      if (!account) {
        accountChecks.guestSeats++;
        if (o.trustLevel !== 'T0') fail('guest_trust', `${id} seat ${o.seat}: ${o.trustLevel}`);
        if (known.has(o.playerId))
          fail('guest_pseudonym', `${id} seat ${o.seat}: stored under its client's id`);
        if (guestIds.has(o.playerId)) fail('guest_pseudonym', `${id}: guest id reused across matches`);
        guestIds.add(o.playerId);
        if (signals.some((x) => x.seat_id === o.seat)) fail('guest_signals', `${id} seat ${o.seat}`);
        continue;
      }
      accountChecks.accountSeats++;
      if (o.trustLevel !== account.trust)
        fail('trust_at_match', `${id} seat ${o.seat}: ${o.trustLevel} vs ${account.trust}`);
      const flag = (name: string) => seatRows.find((r) => r.signal === name)?.flagged;
      if (flag('no_client_signals') !== !account.env)
        fail(
          'no_client_signals',
          `${id} seat ${o.seat}: env ${account.env}, flagged ${flag('no_client_signals')}`,
        );
      if (account.env && flag('headless')) fail('headless', `${id} seat ${o.seat}: clean env flagged`);
      const flagged = seatRows.some((r) => r.flagged);
      if (flagged) accountChecks.flaggedSeats++;
      played.set(o.playerId, flagged);
    }
  }
  // Each account played at most one match (one bot each): its trust history must say exactly that.
  for (const a of accounts.values()) {
    const [p] = await sql.query<{ trust_level: TrustLevel }>(
      'select trust_level from players where player_id = $1',
      [a.playerId],
    );
    const flagged = played.get(a.playerId) ?? false;
    const want = flagged ? lower(a.trust) : a.trust;
    if (p?.trust_level !== want)
      fail('trust_after_match', `${a.playerId}: ${p?.trust_level}, expected ${want}`);
    const lowered = await sql.query<{ n: number }>(
      `select count(*)::int as n from trust_changes where player_id = $1 and reason = 'automation_flag'`,
      [a.playerId],
    );
    const wantLowered = flagged && want !== a.trust ? 1 : 0;
    if (lowered[0]!.n !== wantLowered)
      fail('trust_history', `${a.playerId}: ${lowered[0]!.n} automation_flag rows`);
    accountChecks.lowered += lowered[0]!.n;
  }
  const pool = await sql.query<{ n: number }>('select count(*)::int as n from training_seats');
  if (pool[0]!.n !== 0) fail('training_pool', `${pool[0]!.n} seats in the pool from dev (phase5) matches`);
}

/** Every seated human can reopen their reveal over HTTP; nobody else can. */
async function auditRevealEndpoint(
  url: string,
  store: MemoryStore,
  clients: ClientLog[],
  fail: (check: string, detail: string) => void,
): Promise<void> {
  const http = url.replace(/^ws/, 'http');
  const humans = clients
    .map((c) => ({
      token: c.frames.find((f): f is Extract<ServerMessage, { type: 'welcome' }> => f.type === 'welcome')
        ?.token,
      playerId: c.frames.find((f): f is Extract<ServerMessage, { type: 'welcome' }> => f.type === 'welcome')
        ?.playerId,
      matchId: c.result?.matchId ?? null,
      seat: c.result?.seat ?? null,
    }))
    .filter((h) => h.token && h.matchId && h.playerId?.startsWith('p_'));
  const get = (matchId: string, token: string) =>
    fetch(`${http}/api/matches/${matchId}/reveal`, { headers: { authorization: `Bearer ${token}` } });
  for (const h of humans.slice(0, 40)) {
    const res = await get(h.matchId!, h.token!);
    if (res.status !== 200) {
      fail('reveal_http', `${h.matchId}: seated player got ${res.status}`);
      continue;
    }
    const body = MatchRevealResponseSchema.safeParse(await res.json());
    if (!body.success) {
      fail('reveal_http', `${h.matchId}: response does not match the schema`);
      continue;
    }
    const m = store.matches.get(h.matchId!)!;
    const state = replay(m.meta.config, m.meta.seed, m.inputs).state;
    dbChecks.httpReveals++;
    if (body.data.seat !== h.seat) fail('reveal_http', `${h.matchId}: wrong seat`);
    if (canonicalJson(body.data.reveal) !== canonicalJson(viewFor(state, 0).reveal))
      fail('reveal_http', `${h.matchId}: HTTP reveal ≠ engine reveal`);
  }
  // A player from another match, a bogus token, and no token are all refused.
  const [a, b] = [humans[0], humans.find((h) => h.matchId !== humans[0]?.matchId)];
  if (a && b) {
    const res = await get(a.matchId!, b.token!);
    dbChecks.httpRefusals++;
    if (res.status !== 404) fail('reveal_http_authz', `player from another match got ${res.status}`);
  }
  if (a) {
    dbChecks.httpRefusals += 2;
    if ((await get(a.matchId!, 'f'.repeat(48))).status !== 404)
      fail('reveal_http_authz', 'unknown token not refused');
    const none = await fetch(`${http}/api/matches/${a.matchId}/reveal`);
    if (none.status !== 401) fail('reveal_http_authz', 'missing token not refused');
  }
}

function auditStored(m: StoredMatch, fail: (check: string, detail: string) => void): void {
  const id = m.meta.matchId;
  if (m.meta.status !== 'completed') return fail('match_status', `${id} ended ${m.meta.status}`);
  const replayed = replay(m.meta.config, m.meta.seed, m.inputs);
  if (hashJson(replayed.events) !== hashJson(m.events)) fail('server_replay', `${id}: replay ≠ server log`);
  const vs = auditMatch({
    seed: id,
    config: m.meta.config,
    policies: [],
    events: m.events,
    inputs: m.inputs,
    state: replayed.state,
    rejected: [],
    engineError: null,
    phaseViews: [],
  });
  for (const v of vs) fail(`log:${v.check}`, v.detail);

  const timingBySeq = new Map(m.timings.map((t) => [t.seq, t]));
  for (const e of m.events) {
    if (e.type !== 'decision') continue;
    const t = timingBySeq.get(e.seq);
    if (!t) {
      fail('timing_missing', `${id} seq ${e.seq}`);
      continue;
    }
    if (t.timedOut !== e.payload.timedOut) fail('timing_mismatch', `${id} seq ${e.seq}`);
    if (!e.payload.timedOut && (t.latencyMs === null || t.latencyMs < 0 || t.promptSentAt === null))
      fail('latency', `${id} seq ${e.seq}: ${JSON.stringify(t)}`);
  }
  if (m.timings.length !== m.events.filter((e) => e.type === 'decision').length) fail('timing_count', id);
  for (const r of m.rejections)
    if (r.code !== 'late') fail('rejection', `${id}: ${r.code} on ${r.actionType}`);
}

function auditFrames(c: ClientLog, fail: (check: string, detail: string) => void): void {
  const seat = c.result?.seat ?? null;
  let revealed = false;
  for (const f of c.frames) {
    if (f.type === 'view') {
      if (seat !== null && f.view.seat !== seat)
        fail('foreign_view', `seat ${seat} got seat ${f.view.seat}'s view`);
      if (f.view.phase === 'reveal') revealed = true;
    }
    if (!revealed && ROLE_LEAK.test(JSON.stringify(f)))
      fail('frame_leak', `${f.type} frame mentions roles before Reveal`);
  }
  if (c.result?.matchId && !c.result.finalView)
    fail('no_reveal', `client in ${c.result.matchId} never saw Reveal`);
}

async function main(): Promise<number> {
  const o = parse();
  let total = 0;
  for (const mode of o.modes) {
    const r = await runMode(mode, o);
    total += r.violations.length;
    const byCheck: Record<string, { n: number; eg: string }> = {};
    for (const v of r.violations) {
      byCheck[v.check] ??= { n: 0, eg: v.detail };
      byCheck[v.check]!.n++;
    }
    console.log(`CANUTELL load test — mode ${mode}, clock ×${o.speed}, store ${o.store}, agents ${o.agents}`);
    console.log(
      `  ${r.matches} matches over WebSockets in ${r.seconds.toFixed(1)}s wall time (${r.clients} seated clients)`,
    );
    console.log(
      `  decisions ${r.decisions}, timeouts ${((100 * r.timeouts) / Math.max(1, r.decisions)).toFixed(1)}%`,
    );
    console.log(
      `  server-measured latency (virtual ms): p10 ${quantile(r.latencies, 0.1)}  p50 ${quantile(r.latencies, 0.5)}  p90 ${quantile(r.latencies, 0.9)}`,
    );
    console.log(`  rejections: ${JSON.stringify(r.rejections)}  (only "late" is acceptable)`);
    if (o.store === 'postgres') {
      console.log(
        `  database: ${dbChecks.matches} matches verified against the server log and engine reveal; ` +
          `${dbChecks.httpReveals} HTTP reveals checked, ${dbChecks.httpRefusals} unauthorized requests refused`,
      );
      dbChecks.matches = dbChecks.httpReveals = dbChecks.httpRefusals = 0;
      const a = accountChecks;
      console.log(
        `  accounts: ${a.accounts} made; ${a.accountSeats} account seats (${a.flaggedSeats} flagged, ${a.lowered} lowered a level), ` +
          `${a.guestSeats} guest seats under per-match pseudonyms; training pool empty`,
      );
      a.accounts = a.accountSeats = a.guestSeats = a.flaggedSeats = a.lowered = 0;
    }
    if (o.agents === 'python') {
      console.log(
        `  agents: baseline-1 in every agent seat; ${agentChecks.chatLines} agent chat lines safety-checked`,
      );
    }
    console.log(`  VIOLATIONS: ${r.violations.length}${r.violations.length === 0 ? '  ✓' : '  ✗'}`);
    for (const [check, v] of Object.entries(byCheck)) console.log(`    ${check}: ${v.n}  e.g. ${v.eg}`);
    console.log();
  }
  return total === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
