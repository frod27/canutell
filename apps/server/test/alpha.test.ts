import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { createInvite, migrate, pgliteSql, PostgresStore, type Sql } from '@canutell/db';
import { ManualClock, startGameServer, type GameServer } from '../src';
import { nextGameNights, parseGameNights, zonedToUtc } from '../src/game-nights';
import { Client, credential, fakeCeremonies } from './support';

// Closed alpha (DECISIONS Phase 6): invite-only accounts, no guests, the post-match survey, alpha
// tagging, game nights.

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

async function boot(
  o: { accountsOnly?: boolean; invitesRequired?: boolean; alpha?: boolean; gameNights?: string } = {},
) {
  sql = pgliteSql(new PGlite());
  await migrate(sql);
  const store = new PostgresStore(sql);
  const spawned: string[] = [];
  server = await startGameServer({
    clock: new ManualClock(),
    store,
    agentWeights: [0, 0, 1],
    spawnBot: (a) => spawned.push(a.token),
    accounts: { sql, ceremonies: fakeCeremonies },
    accountsOnly: o.accountsOnly,
    invitesRequired: o.invitesRequired,
    alpha: o.alpha,
    gameNights: o.gameNights ? parseGameNights(o.gameNights) : undefined,
  });
  const http = server.url.replace(/^ws/, 'http');
  const api = async (method: string, path: string, body?: unknown, session?: string) => {
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
  };
  const signUp = async (invite?: string) => {
    const opts = await api('POST', '/api/auth/register/options', {
      termsVersion: 1,
      ...(invite ? { invite } : {}),
    });
    if (opts.status !== 200) return { status: opts.status, session: '', error: opts.body.error as string };
    const id = `cred-${Math.random().toString(36).slice(2)}`;
    const done = await api('POST', '/api/auth/register/verify', {
      flowId: opts.body.flowId,
      response: credential(id, opts.body.options.challenge),
    });
    return { status: done.status, session: done.body?.session as string, error: done.body?.error as string };
  };
  const connect = async (token: string | null) => {
    const c = await Client.connect(server!.url);
    clients.push(c);
    c.send({ type: 'hello', token });
    return c;
  };
  return { store, spawned, api, signUp, connect };
}

describe('invite-only sign-up', () => {
  it('needs a usable invite before the passkey ceremony, and consumes one use per account', async () => {
    const t = await boot({ invitesRequired: true });
    expect((await t.signUp()).error).toBe('invalid_invite');
    expect((await t.signUp('AAAA-BBBB-CCCC')).error).toBe('invalid_invite');
    const { code } = await createInvite(sql!, { label: 'test', maxUses: 1, now: Date.now() });
    expect((await t.signUp(code)).status).toBe(200);
    expect((await t.signUp(code)).error).toBe('invalid_invite');
  });

  it('two sign-ups racing for the last use: one gets the account, the other a clear refusal', async () => {
    const t = await boot({ invitesRequired: true });
    const { code } = await createInvite(sql!, { label: 'race', maxUses: 1, now: Date.now() });
    const a = await t.api('POST', '/api/auth/register/options', { termsVersion: 1, invite: code });
    const b = await t.api('POST', '/api/auth/register/options', { termsVersion: 1, invite: code });
    const verify = (o: typeof a, id: string) =>
      t.api('POST', '/api/auth/register/verify', {
        flowId: o.body.flowId,
        response: credential(id, o.body.options.challenge),
      });
    const results = [await verify(a, 'one'), await verify(b, 'two')];
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('invalid_invite');
  });
});

describe('accounts-only server', () => {
  it('refuses guests the same way whatever the queue holds; accounts play; bots are still seated', async () => {
    const t = await boot({ accountsOnly: true, alpha: true });
    const guest = await t.connect(null);
    const err = await guest.wait('error');
    expect(err.code).toBe('account_required');
    expect(guest.frames.some((f) => f.type === 'welcome')).toBe(false);
    guest.send({ type: 'queue.join', mode: 'quick' });
    await guest.wait('error', (e) => e.code === 'hello_first');

    const sessions: string[] = [];
    for (let i = 0; i < 4; i++) sessions.push((await t.signUp()).session);
    const players = [];
    for (const s of sessions) {
      const c = await t.connect(s);
      expect((await c.wait('welcome')).account).not.toBeNull();
      c.send({ type: 'queue.join', mode: 'quick' });
      players.push(c);
    }
    const found = await players[0]!.wait('match.found');
    expect(t.spawned).toHaveLength(2); // the two agent seats still get their (scripted) players

    // A second guest, with a full match running: the refusal is byte-identical.
    const later = await t.connect(null);
    const err2 = await later.wait('error');
    expect(JSON.stringify(err2)).toBe(JSON.stringify(err));

    // Alpha matches carry the cohort flag and no build-phase flag.
    await t.store.drain();
    const [m] = await sql!.query<{ flags: string[] }>('select flags from matches where match_id = $1', [
      found.matchId,
    ]);
    expect(m!.flags).toContain('alpha');
    expect(m!.flags.some((f) => /^phase/.test(f))).toBe(false);
  });
});

describe('post-match survey endpoint', () => {
  it('only for a seated account, only once, only after the match completes', async () => {
    const t = await boot();
    const s = (await t.signUp()).session;
    const res = await t.api('POST', '/api/matches/nope/feedback', { fun: 5, tags: [], comment: null }, s);
    expect(res.status).toBe(404);
    expect(
      (await t.api('POST', '/api/matches/nope/feedback', { fun: 9, tags: [], comment: null }, s)).status,
    ).toBe(400);
    expect(
      (await t.api('POST', '/api/matches/nope/feedback', { fun: 5, tags: [], comment: null })).status,
    ).toBe(401);
    // A real seat in a running match: refused until it completes.
    const others: string[] = [];
    for (let i = 0; i < 3; i++) others.push((await t.signUp()).session);
    const me = await t.connect(s);
    await me.wait('welcome');
    me.send({ type: 'queue.join', mode: 'quick' });
    for (const o of others) {
      const c = await t.connect(o);
      await c.wait('welcome');
      c.send({ type: 'queue.join', mode: 'quick' });
    }
    const found = await me.wait('match.found');
    await t.store.drain();
    const early = await t.api(
      'POST',
      `/api/matches/${found.matchId}/feedback`,
      { fun: 4, tags: ['bugs'], comment: 'hi' },
      s,
    );
    expect(early).toMatchObject({ status: 409, body: { error: 'not_completed' } });
  });
});

describe('game nights', () => {
  it('are the same in every welcome and never depend on the queue', async () => {
    const t = await boot({ gameNights: 'Tue,Thu 20:00-22:00 Europe/Madrid' });
    const a = await t.connect(null);
    const b = await t.connect(null);
    const [wa, wb] = [await a.wait('welcome'), await b.wait('welcome')];
    expect(wa.gameNights).toEqual(wb.gameNights);
    expect(wa.gameNights!.timeZone).toBe('Europe/Madrid');
    expect(wa.gameNights!.windows.length).toBeGreaterThan(0);
    a.send({ type: 'queue.join', mode: 'quick' });
    await a.wait('queue.status');
    const c = await t.connect(null);
    expect((await c.wait('welcome')).gameNights).toEqual(wa.gameNights);
    // The same schedule over plain HTTP, for visitors a closed alpha refuses a welcome.
    const http = await fetch(`${server!.url.replace(/^ws/, 'http')}/api/game-nights`);
    expect(await http.json()).toEqual(wa.gameNights);
  });

  it('parse rules and follow daylight saving time', () => {
    const rules = parseGameNights('Tue,Thu,Sun 20:00-22:00 Europe/Madrid; Sat 23:00-04:00 Europe/Madrid');
    // Thu 22 Oct 2026 is summer time (UTC+2); Sun 25 Oct is after the switch (UTC+1).
    const w = nextGameNights(rules, Date.UTC(2026, 9, 21, 12), 4)!.windows;
    expect(w.map((x) => new Date(x.start).toISOString())).toEqual([
      '2026-10-22T18:00:00.000Z',
      '2026-10-24T21:00:00.000Z', // Sat 23:00 summer time
      '2026-10-25T19:00:00.000Z',
      '2026-10-27T19:00:00.000Z',
    ]);
    // 23:00 → 04:00 spans the switch (03:00 → 02:00): 5 wall-clock hours are 6 real ones.
    expect(w[1]!.end - w[1]!.start).toBe(6 * 3600_000);
    expect(zonedToUtc(2026, 1, 15, 20 * 60, 'America/New_York')).toBe(Date.UTC(2026, 0, 16, 1));
    expect(() => parseGameNights('Funday 20:00-22:00 Europe/Madrid')).toThrow(/unknown day/);
    expect(() => parseGameNights('Tue 20:00-22:00 Mars/Olympus')).toThrow();
    expect(nextGameNights([], Date.now())).toBeNull();
  });
});
