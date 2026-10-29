import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { migrate, pgliteSql, type RevealSource, type Sql } from '@canutell/db';
import {
  ServerMessageSchema,
  type ClientMessage,
  type MatchRevealResponse,
  type ServerMessage,
} from '@canutell/protocol';
import { ManualClock, MemoryStore, startGameServer, type GameServer, type PasskeyCeremonies } from '../src';

// Passkey accounts, sessions, trust at match time, guest pseudonyms and integrity signals over the real
// server (DECISIONS Phase 5). The WebAuthn ceremony itself is faked here: a "response" is accepted when it
// echoes the challenge. The real ceremony runs in the browser e2e test (apps/web/e2e/accounts.mjs).

const fakeCeremonies: PasskeyCeremonies = {
  async registrationOptions() {
    return { challenge: randomBytes(16).toString('base64url') };
  },
  async verifyRegistration(response, challenge) {
    const r = response as { id: string; response: { clientDataJSON: string } };
    if (r.response.clientDataJSON !== challenge) return null;
    return {
      credentialId: r.id,
      publicKey: randomBytes(65),
      signCount: 0,
      transports: ['internal'],
      multiDevice: true,
      backedUp: true,
    };
  },
  async authenticationOptions() {
    return { challenge: randomBytes(16).toString('base64url') };
  },
  async verifyAuthentication(response, challenge, passkey) {
    const r = response as { id: string; response: { clientDataJSON: string } };
    if (r.response.clientDataJSON !== challenge || r.id !== passkey.credentialId) return null;
    return { signCount: passkey.signCount + 1, backedUp: true };
  },
};
const credential = (id: string, challenge: string) => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: challenge },
  clientExtensionResults: {},
});

class Client {
  frames: ServerMessage[] = [];
  closed = false;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessageSchema.parse(JSON.parse(String(d)));
      this.frames.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    ws.on('close', () => (this.closed = true));
  }
  static async connect(url: string, userAgent?: string): Promise<Client> {
    const ws = new WebSocket(url, userAgent ? { headers: { 'user-agent': userAgent } } : {});
    const c = new Client(ws);
    await new Promise((r) => ws.once('open', r));
    return c;
  }
  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
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
}

let sql: Sql;
let server: GameServer;
let store: MemoryStore;
let clock: ManualClock;
let http: string;
const asked: [string, string][] = [];
const clients: Client[] = [];

beforeEach(async () => {
  const db = new PGlite();
  sql = pgliteSql(db);
  await migrate(sql);
  store = new MemoryStore();
  clock = new ManualClock();
  asked.length = 0;
  const reveals: RevealSource = {
    reveal: async (matchId, playerId) => {
      asked.push([matchId, playerId]);
      return {
        matchId,
        mode: 'quick',
        seat: 0,
        reveal: {
          seats: [],
          ballots: [],
          votes: [],
          keyMoments: { biggestStake: null, unreturnedStakes: [], exiles: [] },
        },
        myStakes: [],
      } satisfies MatchRevealResponse;
    },
  };
  server = await startGameServer({
    clock,
    store,
    agentWeights: [0, 0, 1],
    spawnBot: () => {},
    reveals,
    accounts: { sql, ceremonies: fakeCeremonies },
  });
  http = server.url.replace(/^ws/, 'http');
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await server.close();
  await sql.close();
});

async function api(method: string, path: string, body?: unknown, session?: string) {
  const res = await fetch(`${http}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function signUp(credentialId = randomBytes(8).toString('base64url')) {
  const opts = await api('POST', '/api/auth/register/options', { termsVersion: 1 });
  expect(opts.status).toBe(200);
  const done = await api('POST', '/api/auth/register/verify', {
    flowId: opts.body.flowId,
    response: credential(credentialId, opts.body.options.challenge),
  });
  expect(done.status).toBe(200);
  return { session: done.body.session as string, account: done.body.account, credentialId };
}

async function connect(token: string | null, userAgent?: string) {
  const c = await Client.connect(server.url, userAgent);
  clients.push(c);
  c.send({ type: 'hello', token });
  const w = await c.wait('welcome');
  return { c, w };
}

describe('passkey accounts over HTTP', () => {
  it('signs up at T1, confirms age to T2, opts in to research; sessions carry the account', async () => {
    const { session, account } = await signUp();
    expect(session).toMatch(/^s_[0-9a-f]{64}$/);
    expect(account).toMatchObject({ trustLevel: 'T1', ageConfirmed: null, researchConsent: false });
    expect((await api('GET', '/api/me', undefined, session)).body.playerId).toBe(account.playerId);
    expect((await api('POST', '/api/me/age', { year: 1990, month: 1 }, session)).body.trustLevel).toBe('T2');
    expect((await api('POST', '/api/me/age', { year: 1990, month: 1 }, session)).status).toBe(409);
    const consent = await api('PUT', '/api/me/consent/research', { granted: true, version: 1 }, session);
    expect(consent.body.researchConsent).toBe(true);

    const { w } = await connect(session);
    expect(w.playerId).toBe(account.playerId);
    expect(w.token).toBe(session);
    expect(w.account).toMatchObject({ trustLevel: 'T2', researchConsent: true });
  });

  it('signs in with an existing passkey; flows are single use; unknown passkeys and bad sessions are refused', async () => {
    const { credentialId, account } = await signUp();
    const opts = await api('POST', '/api/auth/login/options');
    const ok = await api('POST', '/api/auth/login/verify', {
      flowId: opts.body.flowId,
      response: credential(credentialId, opts.body.options.challenge),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.account.playerId).toBe(account.playerId);
    const replay = await api('POST', '/api/auth/login/verify', {
      flowId: opts.body.flowId,
      response: credential(credentialId, opts.body.options.challenge),
    });
    expect(replay.status).toBe(400);
    const o2 = await api('POST', '/api/auth/login/options');
    const unknown = await api('POST', '/api/auth/login/verify', {
      flowId: o2.body.flowId,
      response: credential('nope', o2.body.options.challenge),
    });
    expect(unknown.status).toBe(401);
    const o3 = await api('POST', '/api/auth/login/options');
    const wrong = await api('POST', '/api/auth/login/verify', {
      flowId: o3.body.flowId,
      response: credential(credentialId, 'not-the-challenge'),
    });
    expect(wrong.status).toBe(401);
    expect((await api('GET', '/api/me')).status).toBe(401);
    expect((await api('GET', '/api/me', undefined, `s_${'0'.repeat(64)}`)).status).toBe(401);
    expect((await api('POST', '/api/auth/register/options', { termsVersion: 99 })).status).toBe(400);
  });

  it('manages passkeys: add another, list, never remove the last', async () => {
    const { session, credentialId } = await signUp();
    const opts = await api('POST', '/api/me/passkeys/options', undefined, session);
    expect(
      (
        await api(
          'POST',
          '/api/me/passkeys/verify',
          { flowId: opts.body.flowId, response: credential('second', opts.body.options.challenge) },
          session,
        )
      ).status,
    ).toBe(204);
    const list = await api('GET', '/api/me/passkeys', undefined, session);
    expect(list.body.passkeys.map((k: { id: string }) => k.id).sort()).toEqual(
      [credentialId, 'second'].sort(),
    );
    expect((await api('DELETE', `/api/me/passkeys/${credentialId}`, undefined, session)).status).toBe(204);
    expect((await api('DELETE', '/api/me/passkeys/second', undefined, session)).status).toBe(409);
  });

  it('signing out takes effect at once: a revoked session is refused on the next hello', async () => {
    const { session } = await signUp();
    expect((await api('POST', '/api/auth/logout', undefined, session)).status).toBe(204);
    const { c, w } = await connect(session);
    expect(w.account).toBeNull();
    expect(w.token).not.toBe(session);
    expect(c.frames.some((f) => f.type === 'error' && f.code === 'session_invalid')).toBe(true);
  });

  it('deleting the account closes its sockets and erases its sessions', async () => {
    const { session } = await signUp();
    const { c } = await connect(session);
    expect((await api('DELETE', '/api/me', undefined, session)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.closed).toBe(true);
    expect((await api('GET', '/api/me', undefined, session)).status).toBe(401);
  });
});

describe('matches with accounts', () => {
  /** One account (T2, research) and three guests queue; two agent seats time out (no bots spawned). */
  async function playOne(session: string, guestTokens: (string | null)[] = [null, null, null]) {
    const me = await connect(session, 'Mozilla/5.0 HeadlessChrome/130.0');
    me.c.send({
      type: 'client.env',
      env: { webdriver: false, headlessUserAgent: false, noLanguages: false, zeroOuterSize: false },
    });
    const guests = [];
    for (const t of guestTokens) {
      const g = await connect(t);
      g.c.send({
        type: 'client.env',
        env: { webdriver: true, headlessUserAgent: false, noLanguages: false, zeroOuterSize: false },
      });
      guests.push(g);
    }
    for (const p of [me, ...guests]) p.c.send({ type: 'queue.join', mode: 'quick' });
    const found = await me.c.wait('match.found');
    await Promise.all(guests.map((g) => g.c.wait('match.found')));
    return { me, guests, matchId: found.matchId, seat: found.seat };
  }

  it('records trust at match time from the database and stores guests under per-match pseudonyms', async () => {
    const { session, account } = await signUp();
    await api('POST', '/api/me/age', { year: 1990, month: 1 }, session);
    const first = await playOne(session);
    const meta = store.matches.get(first.matchId)!.meta;
    const mine = meta.occupants.find((o) => o.seat === first.seat)!;
    expect(mine).toMatchObject({ playerId: account.playerId, trustLevel: 'T2' });
    const guestOcc = meta.occupants.filter((o) => o.kind === 'human' && o.seat !== first.seat);
    expect(guestOcc.every((o) => o.trustLevel === 'T0')).toBe(true);
    // No stored guest id equals the id the guest's own client knows.
    const known = new Set(first.guests.map((g) => g.w.playerId));
    expect(guestOcc.some((o) => known.has(o.playerId))).toBe(false);
    // Nothing about anyone's account ever reaches another client.
    for (const g of first.guests)
      expect(JSON.stringify(g.c.frames)).not.toMatch(/trustLevel|ageConfirmed|researchConsent|"account":\{/);
    expect(JSON.stringify(first.me.c.frames.filter((f) => f.type !== 'welcome'))).not.toMatch(/trustLevel/);

    // Reveal by session: asked under the account's id.
    const rv = await fetch(`${http}/api/matches/${first.matchId}/reveal`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(rv.status).toBe(200);
    expect(asked).toEqual([[first.matchId, account.playerId]]);
    // A guest's reveal is asked under that match's pseudonym.
    const g0 = first.guests[0]!;
    const gseat = (await g0.c.wait('match.found')).seat;
    await fetch(`${http}/api/matches/${first.matchId}/reveal`, {
      headers: { authorization: `Bearer ${g0.w.token}` },
    });
    expect(asked[1]).toEqual([first.matchId, meta.occupants.find((o) => o.seat === gseat)!.playerId]);
  });

  it('stores client signals for the account seat only, with the server-side headless check', async () => {
    const { session } = await signUp();
    const m = await playOne(session);
    m.me.c.send({ type: 'blur' });
    m.me.c.send({ type: 'focus' });
    for (const g of m.guests) g.c.send({ type: 'blur' });
    await new Promise((r) => setTimeout(r, 50));
    const signals = store.matches.get(m.matchId)!.clientSignals;
    expect(signals.every((s) => s.seat === m.seat)).toBe(true);
    expect(signals.map((s) => s.kind)).toEqual(['env', 'blur', 'focus']);
    expect(signals[0]!.value).toEqual({
      webdriver: false,
      headlessUserAgent: false,
      noLanguages: false,
      zeroOuterSize: false,
      serverHeadlessUa: true,
    });
    // Nothing else (no user-agent string) is kept.
    expect(JSON.stringify(signals)).not.toMatch(/Mozilla|HeadlessChrome/);
  });
});

describe('without a database', () => {
  it('answers 501 for account endpoints and treats session tokens as unknown', async () => {
    const plain = await startGameServer({
      clock: new ManualClock(),
      store: new MemoryStore(),
      spawnBot: () => {},
    });
    try {
      const res = await fetch(`${plain.url.replace(/^ws/, 'http')}/api/auth/login/options`, {
        method: 'POST',
      });
      expect(res.status).toBe(501);
      const c = await Client.connect(plain.url);
      c.send({ type: 'hello', token: `s_${'a'.repeat(64)}` });
      const w = await c.wait('welcome');
      expect(w.account).toBeNull();
      c.ws.close();
    } finally {
      await plain.close();
    }
  });
});
