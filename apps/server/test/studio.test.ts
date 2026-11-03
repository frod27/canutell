import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, pgliteSql, PostgresStore, type Sql } from '@canutell/db';
import type { StudioConfig } from '@canutell/protocol';
import { ManualClock, startGameServer, type AgentSeater, type GameServer } from '../src';
import { Client, credential, fakeCeremonies } from './support';

// Agent Studio over the real server (Phase 7; SPEC §Agents, Studio): who gets a public agent seat, the
// maker's private party, strikes, and the HTTP API.

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

let sql: Sql | null = null;
let server: GameServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await server?.close();
  server = null;
  await sql?.close();
  sql = null;
});

async function boot(o: { enabled?: boolean; share?: number } = {}) {
  sql = pgliteSql(new PGlite());
  await migrate(sql);
  const store = new PostgresStore(sql);
  const seated: { token: string; studio: string | null }[] = [];
  const seater: AgentSeater = async (a) => {
    seated.push({ token: a.token, studio: a.studio?.agentVersion ?? null });
    return { agentVersion: a.studio?.agentVersion ?? 'baseline-1', flags: [] };
  };
  server = await startGameServer({
    clock: new ManualClock(),
    store,
    agentWeights: [0, 0, 1],
    spawnBot: () => {},
    random: { int: () => 0 }, // deterministic: share checks pass when share > 0; the first eligible agent is picked
    accounts: { sql, ceremonies: fakeCeremonies },
    agentSeater: seater,
    formationDelayMs: 0,
    studio: { enabled: o.enabled ?? true, share: o.share ?? 1 },
    agentServiceSecret: SECRET,
  });
  const http = server.url.replace(/^ws/, 'http');
  const api = async (
    method: string,
    path: string,
    body?: unknown,
    session?: string,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${http}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  let n = 0;
  const adult = async (age = true) => {
    const opts = await api('POST', '/api/auth/register/options', { termsVersion: 1 });
    const done = await api('POST', '/api/auth/register/verify', {
      flowId: opts.body.flowId,
      response: credential(`c${n++}-${Math.random()}`, opts.body.options.challenge),
    });
    const session = done.body.session as string;
    if (age) await api('POST', '/api/me/age', { year: 1990, month: 1 }, session);
    return { session, playerId: done.body.account.playerId as string };
  };
  const connect = async (session: string) => {
    const c = await Client.connect(server!.url);
    clients.push(c);
    c.send({ type: 'hello', token: session });
    await c.wait('welcome');
    return c;
  };
  const makeAgent = async (session: string, name: string) => {
    const r = await api(
      'POST',
      '/api/studio/agents',
      { name, config: CONFIG, studioTermsVersion: 1 },
      session,
    );
    expect(r.status).toBe(201);
    return r.body.agents.find((a: { name: string }) => a.name === name) as {
      agentId: number;
      version: string;
    };
  };
  const flagsOf = async (matchId: string) => {
    await store.drain();
    const [m] = await sql!.query<{ flags: string[] }>('select flags from matches where match_id = $1', [
      matchId,
    ]);
    const seats = await sql!.query<{ agent_version: string | null }>(
      'select agent_version from seats where match_id = $1 and is_agent order by seat_id',
      [matchId],
    );
    return { flags: m!.flags, agents: seats.map((s) => s.agent_version) };
  };
  return { api, adult, connect, makeAgent, seated, flagsOf };
}

async function publicMatch(t: Awaited<ReturnType<typeof boot>>, sessions: string[]) {
  const cs = [];
  for (const s of sessions) cs.push(await t.connect(s));
  for (const c of cs) c.send({ type: 'queue.join', mode: 'quick' });
  return (await cs[0]!.wait('match.found')).matchId;
}

describe('public agent seats', () => {
  it('a Studio agent takes a public agent seat, at most one seat per agent, and the match is flagged', async () => {
    const t = await boot();
    const maker = await t.adult();
    const agent = await t.makeAgent(maker.session, 'Seated');
    const players = [];
    for (let i = 0; i < 4; i++) players.push((await t.adult()).session);
    const m = await publicMatch(t, players);
    const { flags, agents } = await t.flagsOf(m);
    expect(agents.filter((v) => v === agent.version)).toHaveLength(1); // the other seat stays baseline-1
    expect(agents.filter((v) => v === 'baseline-1')).toHaveLength(1);
    expect(flags).toEqual(expect.arrayContaining(['studio_agents', 'baseline_agents']));
    expect(flags).not.toContain('owner_present');
  });

  it('never seats a maker with their own agent; share 0 and "Studio off" seat only baseline-1', async () => {
    const t = await boot();
    const maker = await t.adult();
    await t.makeAgent(maker.session, 'Mine');
    const others = [];
    for (let i = 0; i < 3; i++) others.push((await t.adult()).session);
    const m = await publicMatch(t, [maker.session, ...others]);
    expect((await t.flagsOf(m)).agents).toEqual(['baseline-1', 'baseline-1']);
  });

  it('share 0 keeps every seat for the control', async () => {
    const t = await boot({ share: 0 });
    const maker = await t.adult();
    await t.makeAgent(maker.session, 'Unseen');
    const players = [];
    for (let i = 0; i < 4; i++) players.push((await t.adult()).session);
    const m = await publicMatch(t, players);
    expect((await t.flagsOf(m)).agents).toEqual(['baseline-1', 'baseline-1']);
  });
});

describe('play with your agent (private party)', () => {
  it('the maker adds their agent; the match is owner_present and seats it; others cannot add theirs', async () => {
    const t = await boot();
    const maker = await t.adult();
    const agent = await t.makeAgent(maker.session, 'Buddy');
    const host = await t.connect(maker.session);
    host.send({ type: 'party.create', mode: 'quick' });
    const party = await host.wait('party.state');
    const friends = [];
    for (let i = 0; i < 3; i++) {
      const f = await t.adult();
      const c = await t.connect(f.session);
      c.send({ type: 'party.join', code: party.code });
      friends.push({ ...f, c });
    }
    // A friend can't add the maker's agent (it isn't theirs).
    friends[0]!.c.send({ type: 'party.agent', agentId: agent.agentId });
    await friends[0]!.c.wait('error', (e) => e.code === 'party');
    host.send({ type: 'party.agent', agentId: agent.agentId });
    await friends[1]!.c.wait('party.state', (s) => s.agent === 'Buddy');
    host.send({ type: 'party.start' });
    const m = (await host.wait('match.found')).matchId;
    const { flags, agents } = await t.flagsOf(m);
    expect(agents).toContain(agent.version);
    expect(flags).toEqual(expect.arrayContaining(['owner_present', 'studio_agents']));
  });

  it('is refused while Studio is off', async () => {
    const t = await boot({ enabled: false });
    const maker = await t.adult();
    const agent = await t.makeAgent(maker.session, 'Offline');
    const c = await t.connect(maker.session);
    c.send({ type: 'party.create', mode: 'quick' });
    await c.wait('party.state');
    c.send({ type: 'party.agent', agentId: agent.agentId });
    await c.wait('error', (e) => e.code === 'party');
  });
});

describe('strikes and the API', () => {
  it('strike reports need the agent secret and a real Studio seat; three pause the agent', async () => {
    const t = await boot();
    const maker = await t.adult();
    const agent = await t.makeAgent(maker.session, 'Loose');
    const players = [];
    for (let i = 0; i < 4; i++) players.push((await t.adult()).session);
    await publicMatch(t, players);
    const token = t.seated.find((s) => s.studio === agent.version)!.token;
    const report = (secret: string, body: object) =>
      t.api('POST', '/internal/agent-strikes', body, undefined, { 'x-agent-secret': secret });
    expect(
      (await report('wrong-secret-0123456789', { token, agentVersion: agent.version, reason: 'x' })).status,
    ).toBe(403);
    expect((await report(SECRET, { token: 'nope', agentVersion: agent.version, reason: 'x' })).status).toBe(
      404,
    );
    for (let i = 0; i < 3; i++)
      expect(
        (await report(SECRET, { token, agentVersion: agent.version, reason: 'contact_details' })).status,
      ).toBe(204);
    const mine = await t.api('GET', '/api/studio/agents', undefined, maker.session);
    expect(mine.body.agents[0]).toMatchObject({ status: 'paused' });
    expect(mine.body.agents[0].stats.strikes).toBe(3);
  });

  it('making agents needs a confirmed 18+ account; leaderboard and names are public', async () => {
    const t = await boot();
    const minor = await t.adult(false);
    const r = await t.api(
      'POST',
      '/api/studio/agents',
      { name: 'Kiddo', config: CONFIG, studioTermsVersion: 1 },
      minor.session,
    );
    expect(r).toMatchObject({ status: 403, body: { error: 'not_eligible' } });
    expect((await t.api('GET', '/api/studio/agents')).status).toBe(401);
    const maker = await t.adult();
    const a = await t.makeAgent(maker.session, 'Public');
    expect(
      (
        await t.api(
          'POST',
          '/api/studio/agents',
          { name: 'Jane Doe', config: CONFIG, studioTermsVersion: 1 },
          maker.session,
        )
      ).body.error,
    ).toBe('bad_name');
    const v2 = await t.api(
      'POST',
      `/api/studio/agents/${a.agentId}/versions`,
      { config: { ...CONFIG, style: 'louder' } },
      maker.session,
    );
    expect(v2.body.agents[0].versionNumber).toBe(2);
    const names = await t.api('GET', `/api/studio/names?v=${a.version},baseline-1`);
    expect(names.body).toEqual({ [a.version]: { name: 'Public', versionNumber: 1 } });
    expect((await t.api('GET', '/api/studio/leaderboard')).body).toMatchObject({
      minLabels: 30,
      entries: [],
    });
    const retired = await t.api('POST', `/api/studio/agents/${a.agentId}/retire`, undefined, maker.session);
    expect(retired.body.agents[0].status).toBe('retired');
  });
});
