import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { BotClient, POLICY_NAMES } from '@canutell/bots';
import { trustLevels, type RevealSource, type Sql, type StoredClientEnv } from '@canutell/db';
import { AccountsApi, type PasskeyCeremonies } from './accounts-api';
import { nextGameNights, type GameNightRule } from './game-nights';
import type { AgentSeater } from './agent-service';
import {
  AI_DISCLOSURE,
  ClientMessageSchema,
  ACCOUNT_REQUIRED,
  SEAT_COUNT,
  SESSION_TOKEN_PATTERN,
  type AccountSummary,
  type ClientMessage,
  type MatchConfig,
  type SeatId,
  type ServerMessage,
  type TrustLevel,
} from '@canutell/protocol';
import type { Clock } from './clock';
import { MatchRunner, type SeatLink } from './match-runner';
import { Matchmaker, type MatchRequest, type Party, type Random } from './matchmaking';
import type { MatchFlag, MatchMeta, MatchStore, SeatOccupant } from './store';

/**
 * Every match carries the build phase it was played in. Until the closed alpha these matches are dev data:
 * never research-eligible, purged before the alpha (DECISIONS "Guest data before accounts").
 */
export const BUILD_PHASE_FLAG = 'phase5' as const;

/** Client signals stored per seat per match, at most (a flood of focus/blur frames is not more evidence). */
const MAX_SIGNALS_PER_MATCH = 500;

/** Version label for scripted bots in agent seats until Phase 4 agents exist. */
export const SCRIPTED_AGENT_VERSION = 'scripted-0';

export interface SpawnBotArgs {
  url: string;
  token: string;
  kind: 'agent' | 'filler';
  speed: number;
}

export interface GameServerOptions {
  clock: Clock;
  store: MatchStore;
  port?: number;
  host?: string;
  agentWeights?: readonly number[];
  /** Dev only: fill waiting queues/parties with bots after this many server ms. */
  fillBotsAfterMs?: number | null;
  random?: Random;
  /** How agent/filler seats get a player. Default: an in-process BotClient over a real socket. */
  spawnBot?: (args: SpawnBotArgs) => void;
  log?: (msg: string) => void;
  /** Called when a match ends (tests, load test). */
  onMatchEnd?: (runner: MatchRunner, status: 'completed' | 'aborted') => void;
  /** Serves GET /api/matches/:id/reveal. Without it the endpoint answers 501 (e.g. JSONL store). */
  reveals?: RevealSource;
  /** Allowed origin for the HTTP API (CORS). Bearer tokens, no cookies, so `*` is the default. */
  corsOrigin?: string;
  /**
   * Passkey accounts (Phase 5). Needs the database. Without it everyone plays as a guest, /api/auth and
   * /api/me answer 501, and session tokens are refused.
   */
  accounts?: { sql: Sql; ceremonies: PasskeyCeremonies; now?: () => number };
  /**
   * Closed alpha (DECISIONS Phase 6). `accountsOnly`: a hello without a valid session is refused with
   * `account_required` (bots and agents are seated by the server and unaffected). `invitesRequired`: sign-up
   * needs an invite code. `alpha`: matches are flagged `alpha` (a cohort, research-eligible) instead of a
   * build phase. `gameNights`: the schedule sent in every welcome, the same for everyone.
   */
  accountsOnly?: boolean;
  invitesRequired?: boolean;
  alpha?: boolean;
  gameNights?: readonly GameNightRule[];
  /** The WebSocket URL agents use to reach this server (e.g. over a private network). Default: its own URL. */
  agentCallbackUrl?: string;
  /**
   * Seats agents from the agent service (services/agents). Without it — or when it fails for a seat — that
   * seat gets a scripted bot (`scripted-0`), and a failure is flagged `agent_fallback`.
   */
  agentSeater?: AgentSeater;
  /**
   * Every match formation takes at least this long (real ms), whether or not it seats agents. Without it, the
   * time from queue to `match.found` would reveal whether the server waited on the agent service — i.e.
   * whether the match has agents (CLAUDE.md invariant 7). Default: 2500 when an agentSeater is set, else 0.
   */
  formationDelayMs?: number;
}

interface Player {
  playerId: string;
  /** Guest or bot token. Account players are found by session (always re-checked in the database). */
  token: string;
  kind: 'human' | 'agent' | 'filler';
  /** Signed in with a passkey account; `playerId` is the account's id. */
  account: boolean;
  socket: WebSocket | null;
  matchId: string | null;
  seat: SeatId | null;
  /** The last environment report from the current connection (integrity signals, account holders only). */
  env: StoredClientEnv | null;
  /** The id each match stored this player under: a guest gets a fresh pseudonym per match. */
  storedIds: Map<string, string>;
  /** Client signals stored for the current match. */
  signals: number;
  /** Wall-clock time this player joined the public queue (for the formation log only). */
  queuedAt: number | null;
}

export interface GameServer {
  url: string;
  port: number;
  runners: ReadonlyMap<string, MatchRunner>;
  stats(): { matchesStarted: number; matchesRunning: number; connections: number; invalidFrames: number };
  close(): Promise<void>;
}

const MAX_PAYLOAD = 64 * 1024;
const RATE_CAPACITY = 30;
const RATE_PER_SEC = 15;
const MAX_INVALID_FRAMES = 50;

const cryptoRandom: Random = { int: (n) => randomInt(n) };

export async function startGameServer(o: GameServerOptions): Promise<GameServer> {
  const clock = o.clock;
  const random = o.random ?? cryptoRandom;
  const log = o.log ?? (() => {});
  const players = new Map<string, Player>(); // by token
  const byId = new Map<string, Player>();
  const runners = new Map<string, MatchRunner>();
  const rosters = new Map<string, Player[]>(); // by match id
  const accounts = o.accounts
    ? new AccountsApi({
        sql: o.accounts.sql,
        ceremonies: o.accounts.ceremonies,
        now: o.accounts.now,
        log,
        invitesRequired: o.invitesRequired,
        onSessionsRevoked: (playerId) => {
          const p = byId.get(playerId);
          if (p?.account) p.socket?.close(4001, 'signed out');
        },
      })
    : null;
  let matchesStarted = 0;
  let invalidFrames = 0;
  let url = '';

  const send = (player: Player, msg: ServerMessage): boolean => {
    const ws = player.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };
  const link = (player: Player): SeatLink => ({ send: (msg) => send(player, msg) });

  const newPlayer = (kind: Player['kind']): Player => {
    const p: Player = {
      playerId: `${kind === 'human' ? 'p' : 'b'}_${randomUUID()}`,
      token: randomBytes(24).toString('hex'),
      kind,
      account: false,
      socket: null,
      matchId: null,
      seat: null,
      env: null,
      storedIds: new Map(),
      signals: 0,
      queuedAt: null,
    };
    players.set(p.token, p);
    byId.set(p.playerId, p);
    return p;
  };

  const spawnBot =
    o.spawnBot ??
    ((args: SpawnBotArgs) => {
      void new BotClient({
        url: args.url,
        token: args.token,
        policy: POLICY_NAMES[random.int(POLICY_NAMES.length)]!,
        seed: args.token,
        speed: args.speed,
      }).run();
    });

  // ---------- match formation ----------

  const formationDelayMs = o.formationDelayMs ?? (o.agentSeater ? 2_500 : 0);
  const onMatch = (req: MatchRequest) => {
    void formMatch(req).catch((e) => log(`match formation failed: ${String(e)}`));
  };

  const formMatch = async (req: MatchRequest) => {
    const matchId = randomUUID();
    const seed = randomBytes(16).toString('hex');
    const bots: Player[] = [];
    const roster: Player[] = req.humans.map((id) => byId.get(id)!).filter(Boolean);
    for (let i = 0; i < req.agents; i++) bots.push(newPlayer('agent'));
    for (let i = 0; i < req.fillers; i++) bots.push(newPlayer('filler'));
    roster.push(...bots);
    if (roster.length !== SEAT_COUNT) {
      log(`match ${matchId}: roster has ${roster.length} players, aborting formation`);
      for (const b of bots) players.delete(b.token);
      return;
    }
    // Random seat order, so seat numbers carry no information about queue order or roles.
    for (let i = roster.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [roster[i], roster[j]] = [roster[j]!, roster[i]!];
    }
    // Ask the agent service for each agent seat before the match starts, so the stored agent_version is the
    // one that actually plays. Any seat it cannot take gets a scripted bot instead.
    const agentVersion = new Map<Player, string>();
    const agentFlags = new Set<MatchFlag>();
    const scripted: Player[] = [];
    const settle = new Promise<void>((resolve) => setTimeout(resolve, formationDelayMs));
    await Promise.all([
      settle,
      ...bots
        .filter((b) => b.kind === 'agent')
        .map(async (b) => {
          const seat = o.agentSeater
            ? await o.agentSeater({
                serverUrl: o.agentCallbackUrl ?? url,
                token: b.token,
                clockSpeed: clock.speed,
              })
            : null;
          if (seat) {
            agentVersion.set(b, seat.agentVersion);
            for (const f of seat.flags) agentFlags.add(f as MatchFlag);
          } else {
            agentVersion.set(b, SCRIPTED_AGENT_VERSION);
            scripted.push(b);
            if (o.agentSeater) agentFlags.add('agent_fallback');
          }
        }),
    ]);
    const config: MatchConfig = {
      matchId,
      mode: req.mode,
      isParty: req.isParty,
      seats: roster.map((p, seat) => ({
        seatId: seat,
        isAgent: p.kind === 'agent',
        agentVersion: p.kind === 'agent' ? agentVersion.get(p)! : null,
      })),
    };
    // Trust at match time (SPEC §Integrity), read fresh from the database: a flag may have lowered it since
    // sign-in. If the read fails, the seat is stored as T0, which can only keep data out of the pool.
    const accountIds = roster.filter((p) => p.account).map((p) => p.playerId);
    let trust = new Map<string, TrustLevel>();
    if (accountIds.length > 0 && o.accounts)
      trust = await trustLevels(o.accounts.sql, accountIds).catch((e) => {
        log(`match ${matchId}: trust lookup failed, seating accounts as T0: ${String(e)}`);
        return new Map<string, TrustLevel>();
      });
    // A guest is stored under a pseudonym that is new for this match, so nothing links a guest's matches
    // (DECISIONS "Guests and deleted accounts").
    const occupants: SeatOccupant[] = roster.map((p, seat) => {
      const stored = p.kind === 'human' && !p.account ? `p_${randomUUID()}` : p.playerId;
      p.storedIds.set(matchId, stored);
      return p.kind === 'human'
        ? { seat, kind: p.kind, playerId: stored, trustLevel: (p.account && trust.get(p.playerId)) || 'T0' }
        : { seat, kind: p.kind, playerId: stored };
    });
    // Alpha matches are the first real data: a cohort label, no build-phase flag.
    const flags: MatchFlag[] = [o.alpha ? 'alpha' : BUILD_PHASE_FLAG];
    if (scripted.length > 0) flags.push('scripted_agents');
    if ([...agentVersion.values()].some((v) => v !== SCRIPTED_AGENT_VERSION)) flags.push('baseline_agents');
    for (const f of [...agentFlags].sort()) flags.push(f);
    if (req.fillers > 0) flags.push('bot_fill');
    if (clock.speed !== 1) flags.push('sped_up');
    const meta: MatchMeta = {
      matchId,
      mode: req.mode,
      seed,
      isParty: req.isParty,
      config,
      occupants,
      flags,
      createdAt: clock.now(),
      clockSpeed: clock.speed,
      status: 'running',
      endedAt: null,
    };
    const runner = new MatchRunner(meta, { clock, store: o.store, onEnd, log });
    runners.set(matchId, runner);
    rosters.set(matchId, roster);
    matchesStarted++;
    roster.forEach((p, seat) => {
      p.matchId = matchId;
      p.seat = seat;
      p.signals = 0;
    });
    runner.start();
    // Queue waits for the operator (pnpm ops:report points here). Never sent to any client.
    const waits = roster
      .filter((p) => p.kind === 'human' && p.queuedAt !== null)
      .map((p) => Date.now() - p.queuedAt!)
      .sort((a, b) => a - b);
    for (const p of roster) p.queuedAt = null;
    if (waits.length > 0)
      log(
        `match ${matchId} formed (${req.mode}${req.isParty ? ', party' : ''}); queue waits ms: ` +
          `min ${waits[0]} median ${waits[Math.floor(waits.length / 2)]} max ${waits[waits.length - 1]}`,
      );
    // Everyone already connected (humans, and agents that answered the seat request quickly) is told now;
    // anyone connecting later is attached by `hello`.
    for (const p of roster) {
      if (!p.socket) continue;
      send(p, { type: 'match.found', matchId, seat: p.seat!, mode: req.mode, disclosure: AI_DISCLOSURE });
      attach(p, runner);
    }
    for (const b of [...scripted, ...bots.filter((x) => x.kind === 'filler')])
      spawnBot({ url, token: b.token, kind: b.kind as 'agent' | 'filler', speed: clock.speed });
  };

  /** Integrity signals (SPEC §Integrity): stored only for account holders' seats, never for guests. */
  const signal = (p: Player, kind: 'env' | 'focus' | 'blur') => {
    if (!p.account || p.seat === null || !p.matchId || !runners.has(p.matchId)) return;
    if (kind === 'env' && !p.env) return;
    if (p.signals >= MAX_SIGNALS_PER_MATCH) return;
    p.signals++;
    o.store.clientSignal(p.matchId, {
      seat: p.seat,
      at: clock.now(),
      kind,
      value: kind === 'env' ? p.env : null,
    });
  };
  const attach = (p: Player, runner: MatchRunner) => {
    runner.attach(p.seat!, link(p));
    signal(p, 'env');
  };

  const onEnd = (runner: MatchRunner, status: 'completed' | 'aborted') => {
    runners.delete(runner.matchId);
    const roster = rosters.get(runner.matchId) ?? [];
    rosters.delete(runner.matchId);
    for (const p of roster) {
      if (p.matchId !== runner.matchId) continue;
      p.matchId = null;
      p.seat = null;
      if (p.kind !== 'human') {
        players.delete(p.token);
        byId.delete(p.playerId);
      }
    }
    o.onMatchEnd?.(runner, status);
  };

  const onPartyChange = (party: Party, closedReason?: string) => {
    for (const id of party.members) {
      const p = byId.get(id);
      if (!p) continue;
      if (closedReason !== undefined) {
        if (closedReason !== 'started')
          send(p, { type: 'party.closed', code: party.code, reason: closedReason });
        continue;
      }
      send(p, {
        type: 'party.state',
        code: party.code,
        mode: party.mode,
        members: party.members.length,
        isHost: party.host === id,
        canStart: party.host === id && matchmaker.canStart(party),
        disclosure: AI_DISCLOSURE,
      });
    }
  };

  const matchmaker = new Matchmaker({
    clock,
    random,
    agentWeights: o.agentWeights ?? [1, 1, 1],
    fillBotsAfterMs: o.fillBotsAfterMs ?? null,
    onMatch,
    onPartyChange,
  });

  // ---------- sockets ----------

  const cors = {
    'access-control-allow-origin': o.corsOrigin ?? '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const http: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (path === '/health') return reply(res, 200, { ok: true, matches: runners.size });
    // Public and the same for everyone (also for visitors the closed alpha refuses a welcome).
    if (path === '/api/game-nights' && req.method === 'GET')
      return reply(res, 200, o.gameNights ? nextGameNights(o.gameNights, Date.now()) : null);
    if (accounts?.handle(req, res, path, (status, body) => reply(res, status, body))) return;
    if (path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/me/'))
      return reply(res, 501, { error: 'accounts need the database' });
    const m = /^\/api\/matches\/([A-Za-z0-9-]{1,128})\/reveal$/.exec(path);
    if (m && req.method === 'GET') {
      // Only a player who held a seat in the match gets an answer; everyone else gets 404. An account sees
      // its reveals from any device; a guest only from the device (token) that played, until a restart.
      const token = /^Bearer ([0-9a-f]{48}|s_[0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return reply(res, 401, { error: 'missing bearer token' });
      if (!o.reveals) return reply(res, 501, { error: 'reveals need the postgres store' });
      const reveals = o.reveals;
      const matchId = m[1]!;
      const whom = async (): Promise<string | null> => {
        if (SESSION_TOKEN_PATTERN.test(token)) return (await accounts?.resolve(token))?.playerId ?? null;
        const player = players.get(token);
        if (!player || player.kind !== 'human' || player.account) return null;
        return player.storedIds.get(matchId) ?? null;
      };
      whom()
        .then((id) => (id ? reveals.reveal(matchId, id) : null))
        .then(
          (r) => (r ? reply(res, 200, r) : reply(res, 404, { error: 'not found' })),
          (e) => {
            log(`reveal ${matchId} failed: ${String(e)}`);
            reply(res, 500, { error: 'internal error' });
          },
        );
      return;
    }
    reply(res, 404, { error: 'not found' });
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (ws, req) => {
    let player: Player | null = null;
    // Reduced to a boolean at once; the user-agent string is never kept (SPEC §Integrity).
    const serverHeadlessUa = /HeadlessChrome/i.test(req.headers['user-agent'] ?? '');
    let queue: Promise<void> = Promise.resolve();
    let tokens = RATE_CAPACITY;
    let last = performance.now();
    let invalid = 0;
    const error = (code: string, message: string) =>
      ws.send(JSON.stringify({ type: 'error', code, message }));

    ws.on('message', (data) => {
      const t = performance.now();
      tokens = Math.min(RATE_CAPACITY, tokens + ((t - last) / 1000) * RATE_PER_SEC);
      last = t;
      if (tokens < 1) return error('rate_limited', 'too many messages');
      tokens -= 1;

      let msg: ClientMessage;
      try {
        const parsed = ClientMessageSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid');
        msg = parsed.data;
      } catch (e) {
        invalidFrames++;
        if (++invalid >= MAX_INVALID_FRAMES) ws.close(1008, 'too many invalid messages');
        return error('invalid_message', (e as Error).message);
      }

      // Frames are handled in order; only `hello` with a session token waits (on the database).
      queue = queue
        .then(async () => {
          if (msg.type === 'hello') {
            player = await hello(ws, msg.token, player);
            return;
          }
          if (!player) return error('hello_first', 'send hello first');
          if (msg.type === 'client.env') {
            player.env = { ...msg.env, serverHeadlessUa };
            signal(player, 'env');
            return;
          }
          if (msg.type === 'focus' || msg.type === 'blur') return signal(player, msg.type);
          handle(player, msg, error);
        })
        .catch((e) => log(`frame handling failed: ${String(e)}`));
    });

    ws.on('close', () => {
      if (!player || player.socket !== ws) return;
      player.socket = null;
      if (player.matchId) runners.get(player.matchId)?.detach(player.seat!);
      matchmaker.leave(player.playerId);
      matchmaker.leaveParty(player.playerId);
    });
  });

  const hello = async (
    ws: WebSocket,
    token: string | null,
    current: Player | null,
  ): Promise<Player | null> => {
    let p: Player | undefined;
    let account: AccountSummary | null = null;
    if (token && SESSION_TOKEN_PATTERN.test(token)) {
      // A session is re-checked on every hello, so signing out or deleting the account takes effect at once.
      account = accounts ? await accounts.resolve(token).catch(() => null) : null;
      if (!account) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'session_invalid',
              message: 'signed out; playing as a guest',
            }),
          );
      } else {
        p = byId.get(account.playerId);
        if (!p) {
          p = {
            playerId: account.playerId,
            token: '',
            kind: 'human',
            account: true,
            socket: null,
            matchId: null,
            seat: null,
            env: null,
            storedIds: new Map(),
            signals: 0,
            queuedAt: null,
          };
          byId.set(p.playerId, p);
        }
      }
    } else if (token) p = players.get(token);
    // Closed alpha: only accounts play. Bot and agent tokens are issued by the server itself.
    const refused = o.accountsOnly === true && !account && !(p && p.kind !== 'human');
    if (current && p !== current) {
      // A second hello on one socket switches identity; detach the old one cleanly.
      current.socket = null;
      if (current.matchId) runners.get(current.matchId)?.detach(current.seat!);
    }
    if (refused) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: 'error',
            code: ACCOUNT_REQUIRED,
            message: 'The closed alpha is for invited accounts: sign in or sign up with your invite code.',
          }),
        );
      return null;
    }
    if (!p) p = newPlayer('human');
    if (p.socket && p.socket !== ws) p.socket.close(4000, 'replaced by a new connection');
    if (p.socket !== ws) p.env = null; // a new connection reports its own environment
    p.socket = ws;
    const runner = p.matchId ? runners.get(p.matchId) : undefined;
    send(p, {
      type: 'welcome',
      playerId: p.playerId,
      token: account ? token! : p.token,
      serverTime: clock.now(),
      resumedMatchId: runner ? runner.matchId : null,
      account,
      gameNights: o.gameNights ? nextGameNights(o.gameNights, Date.now()) : null,
    });
    if (runner && p.seat !== null) {
      send(p, {
        type: 'match.found',
        matchId: runner.matchId,
        seat: p.seat,
        mode: runner.meta.mode,
        disclosure: AI_DISCLOSURE,
      });
      attach(p, runner);
    }
    return p;
  };

  const handle = (p: Player, msg: ClientMessage, error: (code: string, message: string) => void) => {
    const inMatch = p.matchId !== null && runners.has(p.matchId);
    switch (msg.type) {
      case 'queue.join':
        if (p.kind !== 'human') return error('forbidden', 'bots are seated by the server');
        if (inMatch) return error('in_match', 'finish your current match first');
        matchmaker.leaveParty(p.playerId);
        matchmaker.join(p.playerId, msg.mode);
        p.queuedAt = Date.now();
        if (p.matchId === null)
          send(p, { type: 'queue.status', mode: msg.mode, state: 'searching', disclosure: AI_DISCLOSURE });
        return;
      case 'queue.leave':
        matchmaker.leave(p.playerId);
        send(p, { type: 'queue.status', mode: null, state: 'idle', disclosure: AI_DISCLOSURE });
        return;
      case 'party.create':
        if (p.kind !== 'human') return error('forbidden', 'bots cannot host parties');
        if (inMatch) return error('in_match', 'finish your current match first');
        matchmaker.createParty(p.playerId, msg.mode);
        return;
      case 'party.join': {
        if (p.kind !== 'human') return error('forbidden', 'bots cannot join parties');
        if (inMatch) return error('in_match', 'finish your current match first');
        const r = matchmaker.joinParty(p.playerId, msg.code);
        if (typeof r === 'string') error('party', r);
        return;
      }
      case 'party.leave':
        matchmaker.leaveParty(p.playerId);
        return;
      case 'party.start': {
        const r = matchmaker.startParty(p.playerId);
        if (r) error('party', r);
        return;
      }
      case 'action': {
        const runner = p.matchId ? runners.get(p.matchId) : undefined;
        if (!runner || p.seat === null) {
          send(p, {
            type: 'action.rejected',
            clientActionId: msg.clientActionId,
            code: 'no_match',
            message: 'not in a match',
          });
          return;
        }
        runner.handleAction(p.seat, msg);
        return;
      }
      case 'ping':
        send(p, { type: 'pong', t: msg.t, serverTime: clock.now() });
        return;
    }
  };

  await new Promise<void>((resolve) => http.listen(o.port ?? 0, o.host ?? '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  url = `ws://${o.host ?? '127.0.0.1'}:${port}`;
  log(`CANUTELL server listening on ${url} (clock speed ${clock.speed})`);

  return {
    url,
    port,
    runners,
    stats: () => ({
      matchesStarted,
      matchesRunning: runners.size,
      connections: wss.clients.size,
      invalidFrames,
    }),
    async close() {
      for (const r of [...runners.values()]) r.shutdown();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await o.store.shutdown();
    },
  };
}
