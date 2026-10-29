import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RevealSource } from '@canutell/db';
import {
  ServerMessageSchema,
  type ClientMessage,
  type MatchRevealResponse,
  type ServerMessage,
} from '@canutell/protocol';
import {
  BUILD_PHASE_FLAG,
  JsonlStore,
  ManualClock,
  MemoryStore,
  startGameServer,
  type GameServer,
  type MatchStore,
} from '../src';

// Socket-level integration: a real server on a random port, real WebSocket clients, a manual clock.
// Agent seats get no bot here (spawnBot is a no-op), so they simply time out.

class TestClient {
  frames: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessageSchema.parse(JSON.parse(String(d)));
      this.frames.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    const c = new TestClient(ws);
    await new Promise((r) => ws.once('open', r));
    return c;
  }
  send(m: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }
  raw(s: string): void {
    this.ws.send(s);
  }
  wait<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) {
    const hit = this.frames.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (hit) return Promise.resolve(hit as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
  lastView() {
    return [...this.frames]
      .reverse()
      .find((m): m is Extract<ServerMessage, { type: 'view' }> => m.type === 'view');
  }
  close() {
    this.ws.close();
  }
}

let server: GameServer | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  server = null;
});

async function boot(
  opts: { weights?: number[]; store?: MatchStore; clock?: ManualClock; reveals?: RevealSource } = {},
) {
  const clock = opts.clock ?? new ManualClock();
  const store = opts.store ?? new MemoryStore();
  const spawned: string[] = [];
  server = await startGameServer({
    clock,
    store,
    agentWeights: opts.weights ?? [0, 0, 1],
    spawnBot: (a) => spawned.push(a.kind),
    reveals: opts.reveals,
  });
  const join = async () => {
    const c = await TestClient.connect(server!.url);
    clients.push(c);
    c.send({ type: 'hello', token: null });
    const w = await c.wait('welcome');
    return { c, token: w.token, playerId: w.playerId };
  };
  return { clock, store, spawned, join };
}

async function fullQueue(t: Awaited<ReturnType<typeof boot>>, n = 4) {
  const players = [];
  for (let i = 0; i < n; i++) players.push(await t.join());
  for (const p of players) p.c.send({ type: 'queue.join', mode: 'quick' });
  await Promise.all(players.map((p) => p.c.wait('view')));
  return players;
}

const ROLE_LEAK = /isAgent|agentVersion|scripted-0/;

describe('handshake and frame validation', () => {
  it('issues a pseudonymous id and token; rejects garbage and pre-hello frames', async () => {
    await boot();
    const c = await TestClient.connect(server!.url);
    clients.push(c);
    c.send({ type: 'queue.join', mode: 'full' });
    await c.wait('error', (m) => m.code === 'hello_first');
    c.raw('{not json');
    c.send({ type: 'teleport' });
    c.send({ type: 'ping', t: 1 }); // valid shape, but still before hello
    await c.wait('error', () => c.frames.filter((f) => f.type === 'error').length >= 4);
    expect(c.frames.map((f) => (f.type === 'error' ? f.code : f.type))).toEqual([
      'hello_first',
      'invalid_message',
      'invalid_message',
      'hello_first',
    ]);
    c.send({ type: 'hello', token: null });
    const w = await c.wait('welcome');
    expect(w.playerId).toMatch(/^p_[0-9a-f-]{36}$/);
    expect(w.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('rate-limits floods', async () => {
    await boot();
    const c = await TestClient.connect(server!.url);
    clients.push(c);
    c.send({ type: 'hello', token: null });
    for (let i = 0; i < 80; i++) c.send({ type: 'ping', t: i });
    await c.wait('error', (m) => m.code === 'rate_limited');
  });
});

describe('matchmaking over sockets', () => {
  it('seats humans in distinct seats with the AI disclosure; agent seats get server-spawned bots', async () => {
    const t = await boot({ weights: [0, 0, 1] });
    const players = await fullQueue(t);
    const found = await Promise.all(players.map((p) => p.c.wait('match.found')));
    expect(new Set(found.map((f) => f.seat)).size).toBe(4);
    for (const f of found) expect(f.disclosure).toBe('This match may contain AI players.');
    expect(t.spawned).toEqual(['agent', 'agent']);
  });

  it('queue status carries no player counts (CLAUDE.md invariant 7)', async () => {
    const t = await boot({ weights: [1, 0, 0] });
    const a = await t.join();
    a.c.send({ type: 'queue.join', mode: 'full' });
    const s = await a.c.wait('queue.status');
    expect(Object.keys(s).sort()).toEqual(['disclosure', 'mode', 'state', 'type']);
  });

  it('a party match is tagged isParty in the stored config', async () => {
    const t = await boot();
    const host = await t.join();
    host.c.send({ type: 'party.create', mode: 'quick' });
    const st = await host.c.wait('party.state');
    const others = [await t.join(), await t.join(), await t.join()];
    for (const o of others) o.c.send({ type: 'party.join', code: st.code });
    await host.c.wait('party.state', (m) => m.members === 4 && m.canStart);
    host.c.send({ type: 'party.start' });
    await host.c.wait('match.found');
    const stored = [...(t.store as MemoryStore).matches.values()][0]!;
    expect(stored.meta.isParty).toBe(true);
    expect(stored.meta.config.isParty).toBe(true);
    expect(stored.meta.flags).toContain('scripted_agents');
  });
});

describe('playing a match over sockets', () => {
  it('each client sees only its own seat; no frame carries roles before Reveal; the match completes', async () => {
    const t = await boot({ weights: [0, 0, 1] });
    const players = await fullQueue(t);
    const seats = await Promise.all(players.map((p) => p.c.wait('match.found').then((f) => f.seat)));
    const matchId = (await players[0]!.c.wait('match.found')).matchId;
    players[0]!.c.send({
      type: 'action',
      matchId,
      clientActionId: 'inv',
      action: { type: 'invest', seat: seats[0]!, amount: 12 },
      seenPhase: { round: 1, phase: 'invest' },
      clientSentAt: 123,
    });
    await players[0]!.c.wait('action.ack', (m) => m.clientActionId === 'inv');
    // Spoofing another seat is rejected.
    players[0]!.c.send({
      type: 'action',
      matchId,
      clientActionId: 'spoof',
      action: { type: 'invest', seat: seats[1]!, amount: 1 },
      seenPhase: null,
      clientSentAt: null,
    });
    await players[0]!.c.wait(
      'action.rejected',
      (m) => m.clientActionId === 'spoof' && m.code === 'not_your_seat',
    );

    while (t.clock.next()) await new Promise((r) => setTimeout(r, 2));
    await Promise.all(players.map((p) => p.c.wait('view', (m) => m.view.phase === 'reveal')));
    players.forEach((p, i) => {
      let revealed = false;
      for (const f of p.c.frames) {
        if (f.type === 'view') {
          expect(f.view.seat).toBe(seats[i]);
          if (f.view.phase === 'reveal') revealed = true;
        }
        if (!revealed) expect(JSON.stringify(f)).not.toMatch(ROLE_LEAK);
      }
    });
    const reveal = players[0]!.c.lastView()!.view.reveal!;
    expect(reveal.seats.filter((s) => s.isAgent)).toHaveLength(2);
    const stored = (t.store as MemoryStore).matches.get(matchId)!;
    expect(stored.meta.status).toBe('completed');
    expect(stored.timings.find((r) => r.seat === seats[0] && r.kind === 'invest')).toMatchObject({
      timedOut: false,
      clientSentAt: 123,
    });
  });

  it('a reconnecting player resumes their seat with the token and gets the current view', async () => {
    const t = await boot();
    const players = await fullQueue(t);
    const found = await players[1]!.c.wait('match.found');
    players[1]!.c.close();
    await new Promise((r) => setTimeout(r, 20));
    t.clock.next(); // Invest ends while they are away
    const back = await TestClient.connect(server!.url);
    clients.push(back);
    back.send({ type: 'hello', token: players[1]!.token });
    const w = await back.wait('welcome');
    expect(w.resumedMatchId).toBe(found.matchId);
    expect(w.playerId).toBe(players[1]!.playerId);
    const v = await back.wait('view');
    expect(v.view.seat).toBe(found.seat);
    expect(v.view.phase).toBe('deal');
    const conns = (t.store as MemoryStore).matches
      .get(found.matchId)!
      .connections.filter((c) => c.seat === found.seat);
    expect(conns.map((c) => c.state)).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('a seated player cannot join a queue', async () => {
    const t = await boot();
    const players = await fullQueue(t);
    players[0]!.c.send({ type: 'queue.join', mode: 'full' });
    await players[0]!.c.wait('error', (m) => m.code === 'in_match');
  });
});

describe('JSONL persistence (Phase 2 store)', () => {
  it('writes every record per match and marks interrupted matches aborted on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canutell-'));
    try {
      const t = await boot({ store: new JsonlStore(dir) });
      const players = await fullQueue(t);
      const { matchId } = await players[0]!.c.wait('match.found');
      t.clock.next();
      await new Promise((r) => setTimeout(r, 20));
      await server!.close(); // shutdown aborts running matches
      server = null;
      const m = JsonlStore.read(dir, matchId);
      expect(m.meta.status).toBe('aborted');
      expect(m.events[0]!.type).toBe('match_created');
      expect(m.inputs.length).toBeGreaterThan(0);
      expect(m.timings.length).toBe(m.events.filter((e) => e.type === 'decision').length);

      // A match left 'running' (e.g. after a crash) is marked aborted when the store reopens.
      const fake = JsonlStore.read(dir, matchId);
      fake.meta.status = 'running';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, matchId, 'meta.json'), JSON.stringify(fake.meta));
      new JsonlStore(dir);
      expect(JsonlStore.read(dir, matchId).meta.status).toBe('aborted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/matches/:id/reveal', () => {
  const fakeReveal = (matchId: string): MatchRevealResponse => ({
    matchId,
    mode: 'quick',
    seat: 2,
    reveal: {
      seats: [],
      ballots: [],
      votes: [],
      keyMoments: { biggestStake: null, unreturnedStakes: [], exiles: [] },
    },
    myStakes: [],
  });

  it('answers only a seated player, by bearer token; everyone else gets 401/404', async () => {
    const asked: [string, string][] = [];
    const t = await boot({
      reveals: {
        reveal: async (matchId, playerId) => {
          asked.push([matchId, playerId]);
          return matchId === 'm-ok' ? fakeReveal(matchId) : null;
        },
      },
    });
    const me = await t.join();
    const http = server!.url.replace(/^ws/, 'http');
    const get = (path: string, token?: string) =>
      fetch(`${http}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

    // A guest is asked about only by the pseudonym of a match it played (DECISIONS "Guests and deleted
    // accounts"); this guest played none. The 200 path for accounts is in accounts.test.ts.
    const no = await get('/api/matches/m-ok/reveal', me.token);
    expect(no.status).toBe(404);
    expect(no.headers.get('access-control-allow-origin')).toBe('*');
    expect(no.headers.get('cache-control')).toBe('no-store');
    expect(asked).toEqual([]);

    expect((await get('/api/matches/m-other/reveal', me.token)).status).toBe(404);
    expect((await get('/api/matches/m-ok/reveal')).status).toBe(401);
    expect((await get('/api/matches/m-ok/reveal', 'a'.repeat(48))).status).toBe(404);
    expect((await get('/api/matches/../etc/reveal', me.token)).status).toBe(404);
    const pre = await fetch(`${http}/api/matches/m-ok/reveal`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
  });

  it('answers 501 when the server has no database', async () => {
    const t = await boot();
    const me = await t.join();
    const res = await fetch(`${server!.url.replace(/^ws/, 'http')}/api/matches/x/reveal`, {
      headers: { authorization: `Bearer ${me.token}` },
    });
    expect(res.status).toBe(501);
  });
});

describe('agent seating (Phase 4)', () => {
  it('seats agents from the agent service, records their version and flags, and falls back per seat', async () => {
    let calls = 0;
    const clock = new ManualClock();
    const store = new MemoryStore();
    const spawned: string[] = [];
    server = await startGameServer({
      clock,
      store,
      agentWeights: [0, 0, 1],
      formationDelayMs: 0,
      spawnBot: (a) => spawned.push(a.kind),
      // First seat: accepted by the service; second: the service fails → scripted fallback.
      agentSeater: async () =>
        ++calls === 1 ? { agentVersion: 'baseline-1', flags: ['latency_prior', 'scripted_chat'] } : null,
    });
    const players = [];
    for (let i = 0; i < 4; i++) {
      const c = await TestClient.connect(server.url);
      clients.push(c);
      c.send({ type: 'hello', token: null });
      await c.wait('welcome');
      players.push(c);
    }
    for (const c of players) c.send({ type: 'queue.join', mode: 'quick' });
    const found = await players[0]!.wait('match.found');
    const meta = (store as MemoryStore).matches.get(found.matchId)!.meta;
    expect(
      meta.config.seats
        .filter((s) => s.isAgent)
        .map((s) => s.agentVersion)
        .sort(),
    ).toEqual(['baseline-1', 'scripted-0']);
    expect(meta.flags).toEqual([
      BUILD_PHASE_FLAG,
      'scripted_agents',
      'baseline_agents',
      'agent_fallback',
      'latency_prior',
      'scripted_chat',
    ]);
    expect(spawned).toEqual(['agent']); // only the fallback seat gets a scripted bot
  });

  it('formation takes the same time with or without agents (no timing side channel)', async () => {
    const timeToMatch = async (weights: number[]) => {
      const clock = new ManualClock();
      server = await startGameServer({
        clock,
        store: new MemoryStore(),
        agentWeights: weights,
        formationDelayMs: 300,
        spawnBot: () => {},
        agentSeater: async () => ({ agentVersion: 'baseline-1', flags: [] }),
      });
      const players = [];
      for (let i = 0; i < 6; i++) {
        const c = await TestClient.connect(server.url);
        clients.push(c);
        c.send({ type: 'hello', token: null });
        await c.wait('welcome');
        players.push(c);
      }
      const t0 = performance.now();
      for (const c of players) c.send({ type: 'queue.join', mode: 'quick' });
      await players[0]!.wait('match.found');
      const ms = performance.now() - t0;
      for (const c of clients.splice(0)) c.close();
      await server.close();
      server = null;
      return ms;
    };
    const none = await timeToMatch([1, 0, 0]);
    const two = await timeToMatch([0, 0, 1]);
    expect(none).toBeGreaterThanOrEqual(290);
    expect(two).toBeGreaterThanOrEqual(290);
    expect(Math.abs(none - two)).toBeLessThan(150);
  });
});
