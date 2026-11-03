import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { migrate, moderateStudioAgent, pgliteSql, PostgresStore, type Sql } from '@canutell/db';
import type { StudioConfig } from '@canutell/protocol';
import { ManualClock, startGameServer, type AgentSeater, type GameServer } from '../src';
import { Alerts, scrubAlert, type AlertKey } from '../src/alerts';
import { DEFAULT_RATE_RULES, parseRateLimits, RateLimiter, type RateRules } from '../src/rate-limit';
import { Client, credential, fakeCeremonies } from './support';

// Pre-launch hardening (docs/proposals/hardening.md): rate limits, Studio moderation over the API, alerts.

const CONFIG: StudioConfig = {
  traits: {
    cooperativeness: 0.5,
    reciprocity: 0.5,
    riskAppetite: 0.5,
    patience: 0.5,
    votePropensity: 0.5,
    chattiness: 0.5,
    randomness: 0.5,
  },
  style: 'calm',
};
const SECRET = 'agent-secret-0123456789';
const IP = 'x-test-ip';

describe('RateLimiter', () => {
  const rules = (over: Partial<RateRules> = {}): RateRules => ({ ...DEFAULT_RATE_RULES, ...over });

  it('allows a burst of `capacity`, then refills evenly over the window; keys and rules are separate', () => {
    let now = 0;
    const l = new RateLimiter(rules({ login: { capacity: 3, windowMs: 3000 } }), {
      now: () => now,
      sweepMs: 0,
    });
    expect([l.take('login', 'a'), l.take('login', 'a'), l.take('login', 'a')]).toEqual([0, 0, 0]);
    expect(l.take('login', 'a')).toBe(1000); // one token per second
    expect(l.take('login', 'b')).toBe(0);
    expect(l.take('register', 'a')).toBe(0);
    now = 1000;
    expect(l.take('login', 'a')).toBe(0);
    expect(l.take('login', 'a')).toBeGreaterThan(0);
  });

  it('forgets a key once its bucket has refilled (no IP is kept longer than the window)', () => {
    let now = 0;
    const l = new RateLimiter(rules({ login: { capacity: 2, windowMs: 1000 } }), {
      now: () => now,
      sweepMs: 0,
    });
    l.take('login', '203.0.113.9');
    expect(l.size).toBe(1);
    now = 400;
    l.sweep();
    expect(l.size).toBe(1);
    now = 600; // 1 + 600 × 0.002 ≥ 2: refilled
    l.sweep();
    expect(l.size).toBe(0);
  });

  it('caps memory under a flood of distinct keys', () => {
    const l = new RateLimiter(rules(), { now: () => 0, sweepMs: 0, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) l.take('publicRead', `k${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it('RATE_LIMITS: defaults, off, and overrides', () => {
    expect(parseRateLimits(undefined)).toEqual(DEFAULT_RATE_RULES);
    expect(parseRateLimits('off')).toBeNull();
    expect(parseRateLimits('register=20/1h, socket=60/1m')).toMatchObject({
      register: { capacity: 20, windowMs: 3_600_000 },
      socket: { capacity: 60, windowMs: 60_000 },
      login: DEFAULT_RATE_RULES.login,
    });
    expect(() => parseRateLimits('nope=1/1m')).toThrow();
    expect(() => parseRateLimits('login=fast')).toThrow();
  });
});

describe('Alerts', () => {
  const setup = (throttleMs = 1000) => {
    let now = 0;
    const posts: { url: string; body: { text: string; content: string } }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const a = new Alerts({
      webhookUrl: 'https://hooks.example/x',
      throttleMs,
      now: () => now,
      fetch: fakeFetch,
    });
    return { a, posts, at: (t: number) => (now = t) };
  };

  it('posts Slack- and Discord-shaped bodies, and masks anything like a player id, session or IP', async () => {
    const { a, posts } = setup();
    a.alert('db_write', 'failed for p_0123456789abcdef from 203.0.113.7 with s_' + 'a'.repeat(64));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const { text, content } = posts[0]!.body;
    expect(text).toBe(content);
    expect(text).toContain('[db_write]');
    expect(text).not.toMatch(/p_0123|203\.0\.113|s_aaaa/);
    expect(scrubAlert('2001:db8:0:0:0:0:2:1')).toBe('[ip]');
  });

  it('the same key fires at most once per window; repeats are counted and reported', async () => {
    vi.useFakeTimers();
    try {
      const { a, posts, at } = setup(1000);
      a.alert('agent_fallback', 'one');
      a.alert('agent_fallback', 'two');
      a.alert('agent_fallback', 'three');
      a.alert('http_500', 'other key');
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      at(1000);
      await vi.advanceTimersByTimeAsync(1000); // the window closes: a summary of the 2 suppressed
      await vi.waitFor(() => expect(posts).toHaveLength(3));
      expect(posts[2]!.body.text).toMatch(/2 more alert/);
      at(5000);
      a.alert('agent_fallback', 'later');
      await vi.waitFor(() => expect(posts).toHaveLength(4));
      expect(posts[3]!.body.text).toContain('later');
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a webhook, alerts are only logged', () => {
    const lines: string[] = [];
    new Alerts({ log: (m) => lines.push(m) }).alert('server_started', 'hi');
    expect(lines).toEqual(['ALERT CANUTELL [server_started] hi']);
  });
});

// ---------- over the real server ----------

let sql: Sql | null = null;
let server: GameServer | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
  await sql?.close();
  sql = null;
});

async function boot(o: { rules?: Partial<RateRules>; seater?: AgentSeater } = {}) {
  sql = pgliteSql(new PGlite());
  await migrate(sql);
  const alerts: { key: AlertKey; text: string }[] = [];
  server = await startGameServer({
    clock: new ManualClock(),
    store: new PostgresStore(sql),
    agentWeights: [0, 0, 1],
    spawnBot: () => {},
    accounts: { sql, ceremonies: fakeCeremonies },
    agentSeater: o.seater,
    formationDelayMs: 0,
    studio: { enabled: true, share: 1 },
    agentServiceSecret: SECRET,
    rateLimits: { ...DEFAULT_RATE_RULES, ...o.rules },
    clientIpHeader: IP,
    alert: (key, text) => alerts.push({ key, text }),
  });
  const http = server.url.replace(/^ws/, 'http');
  const api = async (
    method: string,
    path: string,
    o2: { body?: unknown; session?: string; ip?: string; headers?: Record<string, string> } = {},
  ) => {
    const res = await fetch(`${http}${path}`, {
      method,
      headers: {
        ...(o2.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(o2.session ? { authorization: `Bearer ${o2.session}` } : {}),
        ...(o2.ip ? { [IP]: o2.ip } : {}),
        ...o2.headers,
      },
      body: o2.body === undefined ? undefined : JSON.stringify(o2.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: text ? JSON.parse(text) : undefined,
    };
  };
  let n = 0;
  const adult = async (ip?: string) => {
    const opts = await api('POST', '/api/auth/register/options', { body: { termsVersion: 1 }, ip });
    const done = await api('POST', '/api/auth/register/verify', {
      ip,
      body: {
        flowId: opts.body.flowId,
        response: credential(`c${n++}-${Math.random()}`, opts.body.options.challenge),
      },
    });
    const session = done.body.session as string;
    await api('POST', '/api/me/age', { body: { year: 1990, month: 1 }, session, ip });
    return { session, playerId: done.body.account.playerId as string };
  };
  const socket = (ip?: string) =>
    new Promise<{ ws: WebSocket; code: number | null }>((resolve) => {
      const ws = new WebSocket(server!.url, ip ? { headers: { [IP]: ip } } : {});
      sockets.push(ws);
      ws.once('open', () => setTimeout(() => resolve({ ws, code: null }), 50));
      ws.once('close', (code) => resolve({ ws, code }));
    });
  return { api, adult, socket, alerts, sql: sql! };
}

describe('rate limits on the server', () => {
  it('sign-ups are limited per client IP, with Retry-After; other IPs and internal traffic are not', async () => {
    const t = await boot({ rules: { register: { capacity: 2, windowMs: 3_600_000 } } });
    const start = (ip?: string) =>
      t.api('POST', '/api/auth/register/options', { body: { termsVersion: 1 }, ip });
    expect((await start('198.51.100.1')).status).toBe(200);
    expect((await start('198.51.100.1')).status).toBe(200);
    const third = await start('198.51.100.1');
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('rate_limited');
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    expect((await start('198.51.100.2')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await start()).status).toBe(200); // no client IP header: internal
    expect((await t.api('GET', '/health', { ip: '198.51.100.1' })).status).toBe(200);
  });

  it('new sockets are limited per IP and closed with 1013; agents on the private network are not', async () => {
    const t = await boot({ rules: { socket: { capacity: 2, windowMs: 60_000 } } });
    expect((await t.socket('198.51.100.5')).code).toBeNull();
    expect((await t.socket('198.51.100.5')).code).toBeNull();
    expect((await t.socket('198.51.100.5')).code).toBe(1013);
    expect((await t.socket('198.51.100.6')).code).toBeNull();
    for (let i = 0; i < 4; i++) expect((await t.socket()).code).toBeNull();
  });

  it('Studio writes are limited per account, whatever the IP', async () => {
    const t = await boot({ rules: { studioCreate: { capacity: 1, windowMs: 86_400_000 } } });
    const me = await t.adult();
    const make = (name: string, ip: string) =>
      t.api('POST', '/api/studio/agents', {
        body: { name, config: CONFIG, studioTermsVersion: 1 },
        session: me.session,
        ip,
      });
    expect((await make('Firstone', '198.51.100.7')).status).toBe(201);
    const second = await make('Secondone', '198.51.100.8');
    expect(second.status).toBe(429);
    expect(second.retryAfter).not.toBeNull();
  });
});

describe('moderation as the maker sees it', () => {
  it('a suspended agent shows the reason; saving a version is refused; retiring still works', async () => {
    const t = await boot();
    const me = await t.adult();
    const made = await t.api('POST', '/api/studio/agents', {
      body: { name: 'Edgy', config: CONFIG, studioTermsVersion: 1 },
      session: me.session,
    });
    const agentId = made.body.agents[0].agentId as number;
    await moderateStudioAgent(t.sql, {
      agentId,
      action: 'suspend',
      reason: 'name',
      moderator: 'ops',
      now: Date.now(),
    });
    const mine = await t.api('GET', '/api/studio/agents', { session: me.session });
    expect(mine.body.agents[0]).toMatchObject({
      status: 'suspended',
      pausedReason: 'Suspended by the moderators: name',
    });
    const save = await t.api('POST', `/api/studio/agents/${agentId}/versions`, {
      body: { config: CONFIG },
      session: me.session,
    });
    expect(save).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(
      (await t.api('POST', `/api/studio/agents/${agentId}/retire`, { session: me.session })).status,
    ).toBe(200);
  });
});

describe('alerts from the server', () => {
  it('an agent-service failure and a strike pause raise alerts without player ids', async () => {
    const tokens: string[] = [];
    const t = await boot({
      seater: async (a) => {
        tokens.push(a.token);
        if (!a.studio) return null; // the agent service failed for this seat
        return { agentVersion: a.studio.agentVersion, flags: [] };
      },
    });
    const maker = await t.adult();
    const made = await t.api('POST', '/api/studio/agents', {
      body: { name: 'Pausey', config: CONFIG, studioTermsVersion: 1 },
      session: maker.session,
    });
    const version = made.body.agents[0].version as string;
    const players: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await t.adult();
      const c = await Client.connect(server!.url);
      sockets.push(c.ws);
      c.send({ type: 'hello', token: p.session });
      await c.wait('welcome');
      players.push(c);
    }
    for (const c of players) c.send({ type: 'queue.join', mode: 'quick' });
    await players[0]!.wait('match.found');
    await vi.waitFor(() => expect(t.alerts.map((x) => x.key)).toContain('agent_fallback'));

    // The Studio seat's token is the one the seater accepted with a Studio config.
    let paused = false;
    for (const token of tokens) {
      for (let k = 0; k < 3; k++) {
        const r = await t.api('POST', '/internal/agent-strikes', {
          body: { token, agentVersion: version, reason: 'contact_details' },
          headers: { 'x-agent-secret': SECRET },
        });
        if (r.status !== 204) break;
        paused = true;
      }
    }
    expect(paused).toBe(true);
    expect(t.alerts.map((x) => x.key)).toContain('studio_paused');
    expect(JSON.stringify(t.alerts)).not.toMatch(/p_[0-9a-f]{8}/);
  });
});
