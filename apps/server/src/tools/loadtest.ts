import { parseArgs } from 'node:util';
import { BotClient, POLICY_NAMES, type BotResult } from '@canutell/bots';
import {
  PostgresStore,
  canonicalJson,
  dbRevealSource,
  loadMatch,
  pgSql,
  revealFromDb,
  type MatchStore,
  type RevealSource,
  type Sql,
} from '@canutell/db';
import { hashJson, replay, viewFor } from '@canutell/engine';
import { MatchRevealResponseSchema, ModeSchema, type Mode, type ServerMessage } from '@canutell/protocol';
import { auditMatch, type Violation } from '@canutell/sim';
import { ScaledClock } from '../clock';
import { startGameServer } from '../server';
import { MemoryStore, type StoredMatch } from '../store';

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
    },
  });
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

  const launch = (url: string, token: string | null, queue: Mode | undefined) => {
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
  const server = await startGameServer({
    clock,
    store: pg ? tee(store, pg) : store,
    reveals,
    spawnBot: (args) => launch(args.url, args.token, undefined),
  });

  const started = performance.now();
  const humans: BotClient[] = [];
  const unseated = () => humans.filter((b) => b.seatedMatchId === null).length;
  while (server.stats().matchesStarted < o.matches) {
    // Keep at most one match's worth of humans waiting, and respect the concurrency cap.
    if (server.stats().matchesRunning >= o.concurrency || unseated() >= 6) {
      await sleep(10);
      continue;
    }
    humans.push(launch(server.url, null, mode));
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
  if (sql) {
    for (const e of dbErrors) fail('db_write', e);
    for (const m of store.matches.values()) await auditDatabase(sql, m, fail);
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

/** Writes every record to both stores (the load test compares them). */
function tee(a: MatchStore, b: MatchStore): MatchStore {
  return {
    open: (m) => (a.open(m), b.open(m)),
    events: (id, e) => (a.events(id, e), b.events(id, e)),
    input: (id, i) => (a.input(id, i), b.input(id, i)),
    timing: (id, r) => (a.timing(id, r), b.timing(id, r)),
    connection: (id, r) => (a.connection(id, r), b.connection(id, r)),
    rejection: (id, r) => (a.rejection(id, r), b.rejection(id, r)),
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
  const state = replay(m.meta.config, m.meta.seed, m.inputs).state;
  same('reveal', await revealFromDb(sql, id), viewFor(state, 0).reveal);
  const [row] = await sql.query<{ n: number }>(
    'select count(*)::int as n from decisions where match_id = $1',
    [id],
  );
  if (row?.n !== m.events.filter((e) => e.type === 'decision').length)
    fail('db_derived', `${id}: decision rows ≠ decision events`);
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
    console.log(`CANUTELL load test — mode ${mode}, clock ×${o.speed}, store ${o.store}`);
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
