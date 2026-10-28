import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { BotClient, POLICY_NAMES } from '@canutell/bots';
import type { RevealSource } from '@canutell/db';
import type { AgentSeater } from './agent-service';
import {
  AI_DISCLOSURE,
  ClientMessageSchema,
  SEAT_COUNT,
  type ClientMessage,
  type MatchConfig,
  type SeatId,
  type ServerMessage,
} from '@canutell/protocol';
import type { Clock } from './clock';
import { MatchRunner, type SeatLink } from './match-runner';
import { Matchmaker, type MatchRequest, type Party, type Random } from './matchmaking';
import type { MatchFlag, MatchMeta, MatchStore, SeatOccupant } from './store';

/**
 * Every match carries the build phase it was played in. Until Phase 5 (accounts, consent) all players are
 * guests, so these matches are dev data: never research-eligible, purged before the closed alpha
 * (DECISIONS "Guest data before accounts").
 */
export const BUILD_PHASE_FLAG = 'phase4' as const;

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
  token: string;
  kind: 'human' | 'agent' | 'filler';
  socket: WebSocket | null;
  matchId: string | null;
  seat: SeatId | null;
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
      socket: null,
      matchId: null,
      seat: null,
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
            ? await o.agentSeater({ serverUrl: url, token: b.token, clockSpeed: clock.speed })
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
    const occupants: SeatOccupant[] = roster.map((p, seat) => ({ seat, kind: p.kind, playerId: p.playerId }));
    const flags: MatchFlag[] = [BUILD_PHASE_FLAG];
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
    matchesStarted++;
    roster.forEach((p, seat) => {
      p.matchId = matchId;
      p.seat = seat;
    });
    runner.start();
    // Everyone already connected (humans, and agents that answered the seat request quickly) is told now;
    // anyone connecting later is attached by `hello`.
    for (const p of roster) {
      if (!p.socket) continue;
      send(p, { type: 'match.found', matchId, seat: p.seat!, mode: req.mode, disclosure: AI_DISCLOSURE });
      runner.attach(p.seat!, link(p));
    }
    for (const b of [...scripted, ...bots.filter((x) => x.kind === 'filler')])
      spawnBot({ url, token: b.token, kind: b.kind as 'agent' | 'filler', speed: clock.speed });
  };

  const onEnd = (runner: MatchRunner, status: 'completed' | 'aborted') => {
    runners.delete(runner.matchId);
    for (const occ of runner.meta.occupants) {
      const p = byId.get(occ.playerId);
      if (!p || p.matchId !== runner.matchId) continue;
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
    'access-control-allow-headers': 'authorization',
    'access-control-allow-methods': 'GET, OPTIONS',
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
    const m = /^\/api\/matches\/([A-Za-z0-9-]{1,128})\/reveal$/.exec(path);
    if (m && req.method === 'GET') {
      // Only a player who held a seat in the match gets an answer; everyone else gets 404.
      const token = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return reply(res, 401, { error: 'missing bearer token' });
      const player = players.get(token);
      if (!o.reveals) return reply(res, 501, { error: 'reveals need the postgres store' });
      if (!player || player.kind !== 'human') return reply(res, 404, { error: 'not found' });
      o.reveals.reveal(m[1]!, player.playerId).then(
        (r) => (r ? reply(res, 200, r) : reply(res, 404, { error: 'not found' })),
        (e) => {
          log(`reveal ${m[1]} failed: ${String(e)}`);
          reply(res, 500, { error: 'internal error' });
        },
      );
      return;
    }
    reply(res, 404, { error: 'not found' });
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (ws) => {
    let player: Player | null = null;
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

      if (msg.type === 'hello') {
        player = hello(ws, msg.token, player);
        return;
      }
      if (!player) return error('hello_first', 'send hello first');
      handle(player, msg, error);
    });

    ws.on('close', () => {
      if (!player || player.socket !== ws) return;
      player.socket = null;
      if (player.matchId) runners.get(player.matchId)?.detach(player.seat!);
      matchmaker.leave(player.playerId);
      matchmaker.leaveParty(player.playerId);
    });
  });

  const hello = (ws: WebSocket, token: string | null, current: Player | null): Player => {
    let p = token ? players.get(token) : undefined;
    if (current && p !== current) {
      // A second hello on one socket switches identity; detach the old one cleanly.
      current.socket = null;
      if (current.matchId) runners.get(current.matchId)?.detach(current.seat!);
    }
    if (!p) p = newPlayer('human');
    if (p.socket && p.socket !== ws) p.socket.close(4000, 'replaced by a new connection');
    p.socket = ws;
    const runner = p.matchId ? runners.get(p.matchId) : undefined;
    send(p, {
      type: 'welcome',
      playerId: p.playerId,
      token: p.token,
      serverTime: clock.now(),
      resumedMatchId: runner ? runner.matchId : null,
    });
    if (runner && p.seat !== null) {
      send(p, {
        type: 'match.found',
        matchId: runner.matchId,
        seat: p.seat,
        mode: runner.meta.mode,
        disclosure: AI_DISCLOSURE,
      });
      runner.attach(p.seat, link(p));
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
