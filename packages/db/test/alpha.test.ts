import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createInvite,
  deleteAccount,
  formatOpsReport,
  hashInvite,
  inviteUsable,
  listInvites,
  normalizeInvite,
  opsReport,
  PostgresStore,
  revokeInvite,
  submitFeedback,
  type Sql,
} from '../src';
import { feed, freshDb, makeAccount, metaFor, playerIdFor, simMatch } from './helpers';

// Closed alpha (DECISIONS Phase 6): invite codes, the post-match survey, the operations report.

let sql: Sql;
let done: () => Promise<void>;
beforeAll(async () => {
  ({ sql, done } = await freshDb());
});
afterAll(() => done());

const NOW = Date.UTC(2026, 9, 29, 12);
const passkey = () => ({
  credentialId: randomBytes(16).toString('base64url'),
  publicKey: randomBytes(65),
  signCount: 0,
  transports: [],
  multiDevice: true,
  backedUp: true,
});
const signUp = (invite?: string, now = NOW) =>
  createAccount(sql, { userHandle: randomBytes(32), passkey: passkey(), termsVersion: 1, now, invite });

describe('invite codes', () => {
  it('are readable, stored only hashed, and normalized when typed', async () => {
    const { code } = await createInvite(sql, { label: 'friends of A', maxUses: 2, now: NOW });
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OILU]/);
    expect(normalizeInvite(` ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(code.replace(/-/g, ''));
    const raw = await sql.query<{ row: string }>(
      'select row_to_json(i)::text as row from identity.invites i',
    );
    expect(raw.map((r) => r.row).join()).not.toContain(code.replace(/-/g, ''));
    const [h] = await sql.query<{ hex: string }>(
      `select encode(code_hash, 'hex') as hex from identity.invites limit 1`,
    );
    expect(h!.hex).toBe(hashInvite(code).toString('hex'));
  });

  it('redeem up to max_uses, record the invite on the account, and refuse after that', async () => {
    const { code, inviteId } = await createInvite(sql, { label: 'two', maxUses: 2, now: NOW });
    const a = await signUp(code.toLowerCase());
    await signUp(code);
    await expect(signUp(code)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(await inviteUsable(sql, code, NOW)).toBe(false);
    const [r] = await sql.query<{ invite_id: number }>(
      'select invite_id from identity.identities where player_id = $1',
      [a],
    );
    expect(Number(r!.invite_id)).toBe(inviteId);
    // A refused sign-up leaves nothing behind.
    const accounts = await sql.query('select 1 from identity.identities where invite_id = $1', [inviteId]);
    expect(accounts).toHaveLength(2);
  });

  it('refuse expired, revoked and unknown codes', async () => {
    const exp = await createInvite(sql, { label: 'exp', maxUses: 5, expiresAt: NOW + 1000, now: NOW });
    expect(await inviteUsable(sql, exp.code, NOW)).toBe(true);
    await expect(signUp(exp.code, NOW + 2000)).rejects.toMatchObject({ code: 'invalid_invite' });
    const rev = await createInvite(sql, { label: 'rev', maxUses: 5, now: NOW });
    expect(await revokeInvite(sql, rev.inviteId, NOW)).toBe(true);
    expect(await revokeInvite(sql, rev.inviteId, NOW)).toBe(false);
    await expect(signUp(rev.code)).rejects.toMatchObject({ code: 'invalid_invite' });
    await expect(signUp('AAAA-BBBB-CCCC')).rejects.toMatchObject({ code: 'invalid_invite' });
    expect((await listInvites(sql)).find((i) => i.inviteId === rev.inviteId)?.revokedAt).not.toBeNull();
  });

  it('concurrent sign-ups never exceed max_uses', async () => {
    const { code, inviteId } = await createInvite(sql, { label: 'race', maxUses: 3, now: NOW });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => signUp(code)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const [i] = await sql.query<{ uses: number }>('select uses from identity.invites where invite_id = $1', [
      inviteId,
    ]);
    expect(i!.uses).toBe(3);
  });
});

describe('post-match survey', () => {
  async function playCompleted(index: number) {
    const r = simMatch(index);
    for (const s of r.config.seats.filter((x) => !x.isAgent))
      await makeAccount(sql, playerIdFor(index, s.seatId), { trust: 'T2', research: true });
    const store = new PostgresStore(sql);
    await feed(store, r, metaFor(r, index, ['alpha'], 'T2'), { env: true });
    await store.drain();
    const human = r.config.seats.find((s) => !s.isAgent)!.seatId;
    return { matchId: r.config.matchId, player: playerIdFor(index, human), seat: human, r };
  }

  it('one masked answer per seated player, after completion; never in the training views', async () => {
    const m = await playCompleted(900);
    await submitFeedback(sql, {
      matchId: m.matchId,
      playerId: m.player,
      fun: 4,
      tags: ['great_chat'],
      comment: 'fun! mail me at someone@example.com',
      now: NOW,
    });
    const [row] = await sql.query<{ fun: number; comment: string; seat_id: number }>(
      'select fun, comment, seat_id from match_feedback where match_id = $1',
      [m.matchId],
    );
    expect(row).toEqual({ fun: 4, comment: 'fun! mail me at [email]', seat_id: m.seat });
    await expect(
      submitFeedback(sql, {
        matchId: m.matchId,
        playerId: m.player,
        fun: 5,
        tags: [],
        comment: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'already_answered' });
    await expect(
      submitFeedback(sql, {
        matchId: m.matchId,
        playerId: 'p_00000000-0000-4000-8000-000000000000',
        fun: 5,
        tags: [],
        comment: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(sql.query('delete from match_feedback where match_id = $1', [m.matchId])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      sql.transaction(async (tx) => {
        await tx.exec('set local role canutell_export');
        await tx.query('select * from match_feedback');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('is refused before the match completes, and deleted with the account', async () => {
    const r = simMatch(901);
    const store = new PostgresStore(sql);
    await feed(store, r, metaFor(r, 901, ['alpha'], 'T0'), { close: false });
    await store.drain();
    const human = r.config.seats.find((s) => !s.isAgent)!.seatId;
    await expect(
      submitFeedback(sql, {
        matchId: r.config.matchId,
        playerId: playerIdFor(901, human),
        fun: 3,
        tags: [],
        comment: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_completed' });

    const m = await playCompleted(902);
    await submitFeedback(sql, {
      matchId: m.matchId,
      playerId: m.player,
      fun: 2,
      tags: ['bugs'],
      comment: null,
      now: NOW,
    });
    await deleteAccount(sql, m.player, NOW);
    expect(await sql.query('select 1 from match_feedback where match_id = $1', [m.matchId])).toEqual([]);
  });
});

describe('ops report', () => {
  it('reports fun and data in aggregate, with no player ids', async () => {
    const report = await opsReport(sql, { since: 0 });
    expect(report.matches.completed).toBeGreaterThanOrEqual(2);
    expect(report.survey.answers).toBeGreaterThanOrEqual(1);
    expect(report.trainingSeats).toBeGreaterThan(0); // alpha matches are research-eligible
    const text = formatOpsReport(report);
    expect(text).toMatch(/completion/);
    expect(JSON.stringify(report) + text).not.toMatch(/p_[0-9a-f]{8}/);
  });
});
