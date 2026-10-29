import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountError,
  ageStatus,
  answerAge,
  applyMatchTrust,
  createAccount,
  createSession,
  deleteAccount,
  EXCLUDED_FLAGS,
  findPasskey,
  getAccount,
  pendingReviews,
  PostgresStore,
  purgeMatchesWithFlag,
  rebuildDerived,
  resolveSession,
  restoreTrust,
  reviewSeat,
  revokeAllSessions,
  SESSION_TTL_MS,
  setConsent,
  T3_CLEAN_MATCHES,
  type MatchMeta,
  type Sql,
} from '../src';
import { feed, freshDb, makeAccount, metaFor, playerIdFor, simMatch } from './helpers';

// SPEC §Integrity (trust levels), §Consent and privacy; CLAUDE.md invariants 9 and 10; DECISIONS Phase 5.

let sql: Sql;
let done: () => Promise<void>;
beforeAll(async () => {
  ({ sql, done } = await freshDb());
});
afterAll(() => done());

const NOW = Date.UTC(2026, 9, 29, 12);
const passkey = () => ({
  credentialId: randomBytes(16).toString('base64url'),
  publicKey: randomBytes(77),
  signCount: 0,
  transports: ['internal'],
  multiDevice: true,
  backedUp: true,
});
const newAccount = () =>
  createAccount(sql, { userHandle: randomBytes(32), passkey: passkey(), termsVersion: 1, now: NOW });
const trustOf = async (p: string) =>
  (await sql.query<{ trust_level: string }>('select trust_level from players where player_id = $1', [p]))[0]!
    .trust_level;
const changes = (p: string) =>
  sql.query<{ from_level: string; to_level: string; reason: string; match_id: string | null }>(
    'select from_level, to_level, reason, match_id from trust_changes where player_id = $1 order by change_id',
    [p],
  );
const inPool = async (matchId: string) =>
  (
    await sql.query<{ seat_id: number }>(
      'select seat_id from training_seats where match_id = $1 order by seat_id',
      [matchId],
    )
  ).map((r) => r.seat_id);

/** Plays sim match `index` with its human seats as T2 accounts (research consent), reporting a web client. */
async function play(
  index: number,
  o: {
    flags?: MatchMeta['flags'];
    env?: boolean;
    accounts?: boolean;
    trust?: 'T1' | 'T2';
    close?: boolean;
  } = {},
) {
  const r = simMatch(index);
  const trust = o.trust ?? 'T2';
  if (o.accounts ?? true)
    for (const s of r.config.seats.filter((x) => !x.isAgent))
      await makeAccount(sql, playerIdFor(index, s.seatId), { trust, research: true });
  const store = new PostgresStore(sql);
  await feed(store, r, metaFor(r, index, o.flags ?? [], (o.accounts ?? true) ? trust : 'T0'), {
    env: o.env ?? true,
    close: o.close ?? true,
  });
  await store.drain();
  const humans = r.config.seats.filter((s) => !s.isAgent).map((s) => s.seatId);
  return { r, matchId: r.config.matchId, humans };
}

describe('accounts and sessions', () => {
  it('a passkey account starts at T1 with terms consent and no research consent', async () => {
    const p = await newAccount();
    expect(await getAccount(sql, p)).toEqual({
      playerId: p,
      trustLevel: 'T1',
      ageConfirmed: null,
      researchConsent: false,
    });
    expect(await changes(p)).toEqual([
      { from_level: 'T0', to_level: 'T1', reason: 'account_created', match_id: null },
    ]);
  });

  it('sessions resolve until they expire or are revoked; only the hash is stored', async () => {
    const p = await newAccount();
    const token = await createSession(sql, p, NOW);
    expect(token).toMatch(/^s_[0-9a-f]{64}$/);
    expect((await resolveSession(sql, token, NOW + 1000))?.playerId).toBe(p);
    expect(await resolveSession(sql, token, NOW + SESSION_TTL_MS + 1)).toBeNull();
    expect(await resolveSession(sql, `s_${'0'.repeat(64)}`, NOW)).toBeNull();
    expect(await resolveSession(sql, 'not-a-session-token', NOW)).toBeNull();
    const stored = await sql.query<{ n: number }>(
      `select count(*)::int as n from identity.sessions where encode(token_hash, 'hex') = $1`,
      [token.slice(2)],
    );
    expect(stored[0]!.n).toBe(0);
    await revokeAllSessions(sql, p, NOW + 2000);
    expect(await resolveSession(sql, token, NOW + 3000)).toBeNull();
  });

  it('age: self-attested month and year; only yes/no is stored; answerable once (SPEC §Integrity, T2)', async () => {
    expect(ageStatus(2008, 9, NOW)).toBe('adult');
    expect(ageStatus(2008, 10, NOW)).toBe('unsure'); // the 18th-birthday month: the day decides
    expect(ageStatus(2008, 11, NOW)).toBe('minor');
    const adult = await newAccount();
    expect((await answerAge(sql, adult, { year: 1990, month: 5, now: NOW })).trustLevel).toBe('T2');
    await expect(answerAge(sql, adult, { year: 2015, month: 1, now: NOW })).rejects.toMatchObject({
      code: 'age_already_answered',
    });
    const minor = await newAccount();
    const m = await answerAge(sql, minor, { year: 2012, month: 1, now: NOW });
    expect(m).toMatchObject({ trustLevel: 'T1', ageConfirmed: false });
    const unsure = await newAccount();
    await expect(answerAge(sql, unsure, { year: 2008, month: 10, now: NOW })).rejects.toMatchObject({
      code: 'age_try_later',
    });
    expect((await getAccount(sql, unsure))!.ageConfirmed).toBeNull();
    const cols = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'identity' and table_name = 'identities'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('birth_date');
  });

  it('research consent can be granted and revoked; revocation is logged, never erased', async () => {
    const p = await newAccount();
    await setConsent(sql, p, 'research', true, NOW);
    await setConsent(sql, p, 'research', true, NOW + 1); // idempotent
    expect((await getAccount(sql, p))!.researchConsent).toBe(true);
    await setConsent(sql, p, 'research', false, NOW + 2);
    expect((await getAccount(sql, p))!.researchConsent).toBe(false);
    const rows = await sql.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from consents where player_id = $1 and consent_type = 'research'`,
      [p],
    );
    expect(rows).toEqual([{ revoked: true }]);
  });

  it('consent rows can only be revoked, once', async () => {
    const p = await newAccount();
    await setConsent(sql, p, 'research', true, NOW);
    const [c] = await sql.query<{ consent_id: number }>(
      `select consent_id from consents where player_id = $1 and consent_type = 'research'`,
      [p],
    );
    const id = c!.consent_id;
    await expect(sql.query(`update consents set version = 2 where consent_id = $1`, [id])).rejects.toThrow(
      /only revocation/,
    );
    await expect(sql.query(`delete from consents where consent_id = $1`, [id])).rejects.toThrow(
      /only revocation/,
    );
    await sql.query(
      `update consents set revoked_at = granted_at + interval '1 second' where consent_id = $1`,
      [id],
    );
    await expect(
      sql.query(`update consents set revoked_at = granted_at + interval '1 second' where consent_id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/only revocation/);
  });

  it('trust history is append-only', async () => {
    const p = await newAccount();
    await expect(sql.query('delete from trust_changes where player_id = $1', [p])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      sql.query(`update trust_changes set reason = 'x' where player_id = $1`, [p]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('the training pool view (CLAUDE.md invariant 10)', () => {
  it('admits clean, consented T2 human seats of completed non-dev matches — and every gate excludes', async () => {
    const base = await play(700);
    expect(base.humans.length).toBeGreaterThan(0);
    expect(await inPool(base.matchId)).toEqual(base.humans);

    // Agent seats never.
    const agentSeats = base.r.config.seats.filter((s) => s.isAgent).map((s) => s.seatId);
    for (const a of agentSeats) expect(await inPool(base.matchId)).not.toContain(a);

    // T1 at match time (even if T2 now).
    const t1 = await play(701, { trust: 'T1' });
    for (const h of t1.humans)
      await sql.query(`update players set trust_level = 'T2' where player_id = $1`, [playerIdFor(701, h)]);
    expect(await inPool(t1.matchId)).toEqual([]);

    // T2 at match time but lowered since: excluded retroactively.
    const lowered = await play(702);
    const victim = lowered.humans[0]!;
    await sql.query(`update players set trust_level = 'T1' where player_id = $1`, [playerIdFor(702, victim)]);
    expect(await inPool(lowered.matchId)).toEqual(lowered.humans.slice(1));

    // Consent revoked.
    const revoked = await play(703);
    await setConsent(sql, playerIdFor(703, revoked.humans[0]!), 'research', false, NOW);
    expect(await inPool(revoked.matchId)).toEqual(revoked.humans.slice(1));

    // Deleted account.
    const deleted = await play(704);
    await deleteAccount(sql, playerIdFor(704, deleted.humans[0]!), NOW);
    expect(await inPool(deleted.matchId)).toEqual(deleted.humans.slice(1));

    // Every dev / bot-fill / sped-up flag.
    let i = 705;
    for (const flag of EXCLUDED_FLAGS) {
      const m = await play(i++, { flags: [flag] });
      expect(await inPool(m.matchId), flag).toEqual([]);
    }

    // Aborted (unfinished) match.
    const aborted = await play(i++, { close: false });
    expect(await inPool(aborted.matchId)).toEqual([]);

    // Guests are never in the pool.
    const guests = await play(i++, { accounts: false });
    expect(await inPool(guests.matchId)).toEqual([]);
  });

  it('a flagged seat is out until a reviewer clears it, and out again if a later review confirms', async () => {
    const m = await play(730, { env: false }); // no web client: no_client_signals on every account seat
    expect(await inPool(m.matchId)).toEqual([]);
    const seat = m.humans[0]!;
    await reviewSeat(sql, { matchId: m.matchId, seat, decision: 'cleared', reviewer: 'ops', now: NOW });
    expect(await inPool(m.matchId)).toEqual([seat]);
    await reviewSeat(sql, { matchId: m.matchId, seat, decision: 'confirmed', reviewer: 'ops', now: NOW + 1 });
    expect(await inPool(m.matchId)).toEqual([]);
  });

  it('the export role reads only the training views; identity data is unreachable', async () => {
    await sql.transaction(async (tx) => {
      await tx.exec('set local role canutell_export');
      await tx.query('select count(*) from training_seats');
      await tx.query('select count(*) from training_decisions');
    });
    for (const q of [
      'select * from decisions limit 1',
      'select * from players limit 1',
      'select * from identity.identities limit 1',
      'select * from consents limit 1',
    ]) {
      await expect(
        sql.transaction(async (tx) => {
          await tx.exec('set local role canutell_export');
          await tx.query(q);
        }),
        q,
      ).rejects.toThrow(/permission denied/);
    }
    const view = await sql.query<{ def: string }>(`select pg_get_viewdef('training_seats'::regclass) as def`);
    expect(view[0]!.def).not.toMatch(/identit/);
  });
});

describe('trust after a match (SPEC §Integrity)', () => {
  it('a flag lowers trust one level, once per match; review cleared restores, confirmed sets T1', async () => {
    const m = await play(740, { env: false });
    const [a, b] = m.humans.map((h) => playerIdFor(740, h));
    expect(await trustOf(a!)).toBe('T1');
    expect((await changes(a!)).map((c) => [c.reason, c.match_id])).toEqual([['automation_flag', m.matchId]]);
    await sql.transaction((tx) => applyMatchTrust(tx, m.matchId, NOW)); // idempotent
    expect(await changes(a!)).toHaveLength(1);
    // Rebuilding derived rows never re-applies trust.
    await rebuildDerived(sql, m.matchId);
    expect(await changes(a!)).toHaveLength(1);

    const pending = await pendingReviews(sql);
    expect(pending.filter((p) => p.matchId === m.matchId).map((p) => p.seat)).toEqual(m.humans);
    expect(JSON.stringify(pending)).not.toMatch(/p_/); // no player ids for the reviewer

    await reviewSeat(sql, {
      matchId: m.matchId,
      seat: m.humans[0]!,
      decision: 'cleared',
      reviewer: 'ops',
      now: NOW,
    });
    expect(await trustOf(a!)).toBe('T2');
    await reviewSeat(sql, {
      matchId: m.matchId,
      seat: m.humans[1]!,
      decision: 'confirmed',
      reviewer: 'ops',
      now: NOW,
    });
    expect(await trustOf(b!)).toBe('T1');
    // Nobody is banned: the account still resolves and plays.
    expect(await getAccount(sql, b!)).not.toBeNull();
    // A reviewer can restore by hand, but never past what the account has earned.
    await restoreTrust(sql, { playerId: b!, level: 'T2', now: NOW });
    expect(await trustOf(b!)).toBe('T2');
    const minor = await newAccount();
    await answerAge(sql, minor, { year: 2015, month: 1, now: NOW });
    await expect(restoreTrust(sql, { playerId: minor, level: 'T2', now: NOW })).rejects.toBeInstanceOf(
      AccountError,
    );
  });

  it('reviews only flagged human seats', async () => {
    const m = await play(745);
    await expect(
      reviewSeat(sql, {
        matchId: m.matchId,
        seat: m.humans[0]!,
        decision: 'cleared',
        reviewer: 'ops',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_flagged' });
  });

  it(`T2 becomes T3 after its last ${T3_CLEAN_MATCHES} completed non-dev matches at T2+ are clean`, async () => {
    const player = playerIdFor(9999, 0);
    await makeAccount(sql, player, { trust: 'T2', research: true });
    let played = 0;
    for (let index = 800; played < T3_CLEAN_MATCHES; index++) {
      const r = simMatch(index);
      if (r.config.seats[0]!.isAgent) continue;
      const meta = metaFor(r, index, [], 'T2');
      meta.occupants[0] = { ...meta.occupants[0]!, playerId: player };
      meta.createdAt += index; // ordered
      // A dev match in between never counts towards T3.
      if (played === 5) {
        const dev = metaFor(simMatch(index + 1000), index + 1000, ['phase5'], 'T2');
        dev.occupants = dev.occupants.map((o) => (o.seat === 0 ? { ...o, playerId: player } : o));
        if (!simMatch(index + 1000).config.seats[0]!.isAgent) {
          const s0 = new PostgresStore(sql);
          await feed(s0, simMatch(index + 1000), dev, { env: true });
          await s0.drain();
        }
      }
      const store = new PostgresStore(sql);
      await feed(store, r, meta, { env: true });
      await store.drain();
      const flagged = await sql.query(
        'select 1 from integrity_signals where match_id = $1 and seat_id = 0 and flagged',
        [r.config.matchId],
      );
      expect(flagged, `match ${index} seat 0 should be clean`).toEqual([]);
      played++;
      expect(await trustOf(player)).toBe(played === T3_CLEAN_MATCHES ? 'T3' : 'T2');
    }
    expect((await changes(player)).map((c) => c.reason)).toEqual(['clean_matches']);
  });
});

describe('account deletion (DECISIONS "Guests and deleted accounts")', () => {
  it('erases identity, passkeys, sessions and integrity data; seats stay as anonymous context', async () => {
    const m = await play(760);
    const p = playerIdFor(760, m.humans[0]!);
    const pk = passkey();
    await sql.query(
      `insert into identity.passkeys (credential_id, player_id, public_key, sign_count, multi_device, backed_up)
       values ($1, $2, $3, 0, true, true)`,
      [pk.credentialId, p, Buffer.from(pk.publicKey)],
    );
    const token = await createSession(sql, p, NOW);
    await deleteAccount(sql, p, NOW);
    expect(await getAccount(sql, p)).toBeNull();
    expect(await resolveSession(sql, token, NOW)).toBeNull();
    expect(await findPasskey(sql, pk.credentialId)).toBeNull();
    const left = async (t: string) =>
      (await sql.query<{ n: number }>(`select count(*)::int as n from ${t} where player_id = $1`, [p]))[0]!.n;
    expect(await left('identity.identities')).toBe(0);
    expect(await left('identity.sessions')).toBe(0);
    expect(
      (await sql.query(`select 1 from consents where player_id = $1 and revoked_at is null`, [p])).length,
    ).toBe(0);
    const seatRows = await sql.query(`select 1 from seats where player_id = $1`, [p]);
    expect(seatRows).toHaveLength(1);
    const integrity = () =>
      sql.query(`select 1 from integrity_signals where match_id = $1 and seat_id = $2`, [
        m.matchId,
        m.humans[0],
      ]);
    expect(await integrity()).toEqual([]);
    await rebuildDerived(sql, m.matchId); // rebuilding never brings it back
    expect(await integrity()).toEqual([]);
    expect(await trustOf(p)).toBe('T0');
    await expect(deleteAccount(sql, p, NOW)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('purging dev matches removes accounts that only played in them; accounts without seats stay', async () => {
    const m = await play(770, { flags: ['phase5'] });
    const idle = await newAccount();
    const out = await purgeMatchesWithFlag(sql, 'phase5');
    expect(out.matches).toBeGreaterThanOrEqual(1);
    for (const h of m.humans)
      expect(await sql.query('select 1 from players where player_id = $1', [playerIdFor(770, h)])).toEqual(
        [],
      );
    expect(await getAccount(sql, idle)).not.toBeNull();
  });
});
