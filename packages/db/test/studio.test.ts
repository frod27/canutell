import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STUDIO_LIMITS, type StudioConfig } from '@canutell/protocol';
import {
  createStudioAgent,
  deleteAccount,
  eligibleStudioVersions,
  findStudioAgentId,
  listMyAgents,
  moderateStudioAgent,
  ownAgentForParty,
  PostgresStore,
  purgeMatchesWithFlag,
  recentStudioVersions,
  recordStrike,
  retireStudioAgent,
  saveStudioVersion,
  StudioError,
  studioLeaderboard,
  studioAgentDetail,
  studioNames,
  studioStats,
  type Sql,
} from '../src';
import { feed, freshDb, makeAccount, metaFor, playerIdFor, simMatch } from './helpers';

// Agent Studio (Phase 7; SPEC §Agents, Studio; CLAUDE.md invariants 10 and 13).

let sql: Sql;
let done: () => Promise<void>;
beforeAll(async () => {
  ({ sql, done } = await freshDb());
});
afterAll(() => done());

const NOW = Date.UTC(2026, 10, 3, 12);
const config = (style = 'dry humour, short sentences'): StudioConfig => ({
  traits: {
    cooperativeness: 0.6,
    reciprocity: 0.7,
    riskAppetite: 0.3,
    patience: 0.5,
    votePropensity: 0.5,
    chattiness: 0.4,
    randomness: 0.3,
  },
  style,
});
let maker = 0;
async function newMaker(trust: 'T1' | 'T2' = 'T2') {
  const id = playerIdFor(5000, maker++);
  await makeAccount(sql, id, { trust, research: true });
  return id;
}

/** Plays sim match `index` (one agent seat set to `agentVersion`), human seats as consented T2 accounts. */
async function playWith(index: number, agentVersion: string, o: { ownerAt?: string; party?: boolean } = {}) {
  let i = index;
  while (simMatch(i).config.seats.filter((s) => s.isAgent).length === 0) i++;
  const r = simMatch(i);
  const agentSeat = r.config.seats.find((s) => s.isAgent)!.seatId;
  const config = {
    ...r.config,
    isParty: o.party ?? false,
    seats: r.config.seats.map((s) => (s.seatId === agentSeat ? { ...s, agentVersion } : s)),
  };
  const humans = config.seats.filter((s) => !s.isAgent).map((s) => s.seatId);
  for (const h of humans) await makeAccount(sql, playerIdFor(i, h), { trust: 'T2', research: true });
  const meta = metaFor({ ...r, config }, i, o.ownerAt ? ['owner_present'] : [], 'T2');
  meta.config = config;
  meta.isParty = o.party ?? false;
  if (o.ownerAt)
    meta.occupants = meta.occupants.map((x) => (x.seat === humans[0] ? { ...x, playerId: o.ownerAt! } : x));
  const store = new PostgresStore(sql);
  await feed(store, { ...r, config }, meta, { env: true });
  await store.drain();
  return { matchId: config.matchId, agentSeat, humans, index: i };
}

describe('making Studio agents', () => {
  it('needs a confirmed-18+ maker, records the Studio terms, and makes version 1', async () => {
    const t1 = await newMaker('T1');
    await expect(
      createStudioAgent(sql, { ownerId: t1, name: 'Nopey', config: config(), now: NOW }),
    ).rejects.toMatchObject({
      code: 'not_eligible',
    });
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Marlowe', config: config(), now: NOW });
    expect(a.agentVersion).toBe(`studio:${a.agentId}:v1`);
    const consent = await sql.query(
      `select 1 from consents where player_id = $1 and consent_type = 'studio' and revoked_at is null`,
      [owner],
    );
    expect(consent).toHaveLength(1);
  });

  it('refuses person-like names, taken names (any case), unsafe style hints, and a fourth agent', async () => {
    const owner = await newMaker();
    const make = (name: string, style?: string) =>
      createStudioAgent(sql, { ownerId: owner, name, config: config(style), now: NOW });
    await expect(make('Jane Doe')).rejects.toMatchObject({ code: 'bad_name' });
    await expect(make('marlowe')).rejects.toMatchObject({ code: 'name_taken' });
    await expect(make('Linky', 'visit www.example.com')).rejects.toMatchObject({ code: 'bad_style' });
    await make('One');
    await make('Two');
    await make('Three');
    await expect(make('Four')).rejects.toMatchObject({ code: 'too_many_agents' });
    const [first] = await listMyAgents(sql, owner, NOW);
    await retireStudioAgent(sql, owner, first!.agentId);
    await make('Four'); // retiring frees a place
  });

  it('every saved change is a new immutable version; a paused agent resumes on a new version', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Versiony', config: config(), now: NOW });
    const v2 = await saveStudioVersion(sql, {
      ownerId: owner,
      agentId: a.agentId,
      config: config('louder now'),
      now: NOW + 1,
    });
    expect(v2).toBe(`studio:${a.agentId}:v2`);
    await expect(
      sql.query(`update agent_versions set config = '{}' where agent_version = $1`, [v2]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql.query('delete from agent_versions where agent_version = $1', [a.agentVersion]),
    ).rejects.toThrow(/immutable/);
    const stranger = await newMaker();
    await expect(
      saveStudioVersion(sql, { ownerId: stranger, agentId: a.agentId, config: config(), now: NOW }),
    ).rejects.toBeInstanceOf(StudioError);
    const [mine] = await listMyAgents(sql, owner, NOW);
    expect(mine).toMatchObject({ version: v2, versionNumber: 2, status: 'active' });
    expect(mine!.config.style).toBe('louder now');
  });
});

describe('strikes, seating and the training pool', () => {
  it('three blocked lines pause the agent; strikes only count on a Studio seat of that match', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Strikey', config: config(), now: NOW });
    const m = await playWith(1100, a.agentVersion);
    await expect(
      recordStrike(sql, { agentVersion: 'baseline-1', matchId: m.matchId, reason: 'x', now: NOW }),
    ).rejects.toThrow();
    for (let k = 1; k <= 3; k++) {
      const r = await recordStrike(sql, {
        agentVersion: a.agentVersion,
        matchId: m.matchId,
        reason: 'contact_details',
        now: NOW,
      });
      expect(r.paused).toBe(k === STUDIO_LIMITS.strikesToPause);
    }
    const [mine] = await listMyAgents(sql, owner, NOW);
    expect(mine).toMatchObject({ status: 'paused' });
    expect(mine!.stats.strikes).toBe(3);
    expect(await eligibleStudioVersions(sql, { excludeOwners: [], now: NOW })).not.toContainEqual(
      expect.objectContaining({ agentId: a.agentId }),
    );
    // A new version resumes it, with a fresh record.
    const v2 = await saveStudioVersion(sql, {
      ownerId: owner,
      agentId: a.agentId,
      config: config(),
      now: NOW + 1,
    });
    expect((await studioStats(sql, v2)).strikes).toBe(0);
  });

  it('eligibility excludes the match’s owners, paused and retired agents, and agents over the daily quota', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Quota', config: config(), now: NOW });
    const has = async (excludeOwners: string[], now = NOW) =>
      (await eligibleStudioVersions(sql, { excludeOwners, now })).some((v) => v.agentId === a.agentId);
    expect(await has([])).toBe(true);
    expect(await has([owner])).toBe(false);
    // Fill today's quota with public matches (rows inserted directly; only seats and timestamps matter).
    for (let k = 0; k < STUDIO_LIMITS.matchesPerDay; k++) {
      const id = `quota-${k}`;
      await sql.query(
        `insert into matches (match_id, created_at, mode, ruleset_version, reveal_mode, agent_count, is_party, seed, flags)
         values ($1, $2::timestamptz, 'quick', 'v0.2', 'aggregate', 1, false, 's', '{}')`,
        [id, new Date(NOW - 3600_000).toISOString()],
      );
      await sql.query(
        `insert into seats (match_id, seat_id, kind, agent_version, is_agent) values ($1, 0, 'agent', $2, true)`,
        [id, a.agentVersion],
      );
    }
    expect(await has([])).toBe(false);
    expect(await has([], NOW + 2 * 86_400_000)).toBe(true); // a day later the quota is free again
    expect((await ownAgentForParty(sql, owner, a.agentId))?.agentVersion).toBe(a.agentVersion); // private play has no quota
    await retireStudioAgent(sql, owner, a.agentId);
    expect(await has([], NOW + 2 * 86_400_000)).toBe(false);
    expect(await ownAgentForParty(sql, owner, a.agentId)).toBeNull();
  });

  it('the maker’s own seat in a match with their agent is never training data; the agent seat neither', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Partner', config: config(), now: NOW });
    const m = await playWith(1200, a.agentVersion, { ownerAt: owner, party: true });
    const pool = (
      await sql.query<{ seat_id: number; player_id: string }>(
        'select seat_id, player_id from training_seats where match_id = $1 order by seat_id',
        [m.matchId],
      )
    ).map((r) => r.player_id);
    expect(pool).not.toContain(owner);
    expect(pool.length).toBe(m.humans.length - 1); // the other (consented T2) humans stay eligible
    const seats = await sql.query<{ seat_id: number }>(
      'select seat_id from training_seats where match_id = $1',
      [m.matchId],
    );
    expect(seats.map((s) => s.seat_id)).not.toContain(m.agentSeat);
  });
});

describe('what makers and the public see', () => {
  it('stats are aggregates only; names are public; the leaderboard needs enough labels', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Shown', config: config(), now: NOW });
    await playWith(1300, a.agentVersion);
    const [mine] = await listMyAgents(sql, owner, NOW);
    expect(mine!.stats.matches).toBe(1);
    // No ids of any kind: no player ids, no match ids (sim ids start with the seed), no seats.
    expect(JSON.stringify(mine)).not.toMatch(/p_[0-9a-f]{8}|db-test|"seat/);
    expect(await studioNames(sql, [a.agentVersion, 'baseline-1'])).toEqual({
      [a.agentVersion]: { name: 'Shown', versionNumber: 1 },
    });
    const board = await studioLeaderboard(sql);
    expect(board.minLabels).toBe(STUDIO_LIMITS.minLeaderboardLabels);
    expect(board.entries.find((e) => e.name === 'Shown')).toBeUndefined(); // far below 30 labels
  });

  it('deleting a maker retires their agents; purging dev data keeps makers', async () => {
    const owner = await newMaker();
    await createStudioAgent(sql, { ownerId: owner, name: 'Orphan', config: config(), now: NOW });
    await deleteAccount(sql, owner, NOW);
    const [row] = await sql.query<{ status: string }>(
      `select status from studio_agents where name = 'Orphan'`,
    );
    expect(row!.status).toBe('retired');

    const owner2 = await newMaker();
    const b = await createStudioAgent(sql, { ownerId: owner2, name: 'Kept', config: config(), now: NOW });
    const m = await playWith(1400, b.agentVersion, { ownerAt: owner2 });
    await sql.query(`update matches set flags = array_append(flags, 'phase5') where match_id = $1`, [
      m.matchId,
    ]);
    await purgeMatchesWithFlag(sql, 'phase5');
    expect(await sql.query('select 1 from players where player_id = $1', [owner2])).toHaveLength(1);
  });
});

describe('operator moderation (docs/proposals/hardening.md)', () => {
  const mod = (agentId: number, action: 'suspend' | 'unsuspend' | 'rename' | 'retire', newName?: string) =>
    moderateStudioAgent(sql, {
      agentId,
      action,
      reason: 'test reason',
      moderator: 'ops-1',
      newName,
      now: NOW,
    });

  it('a suspension takes the agent out of public and private play, and a new version does not lift it', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Rowdy', config: config(), now: NOW });
    expect(await findStudioAgentId(sql, 'ROWDY')).toBe(a.agentId);
    expect(await findStudioAgentId(sql, String(a.agentId))).toBe(a.agentId);
    await mod(a.agentId, 'suspend');
    const eligible = await eligibleStudioVersions(sql, { excludeOwners: [], now: NOW });
    expect(eligible.some((v) => v.agentId === a.agentId)).toBe(false);
    expect(await ownAgentForParty(sql, owner, a.agentId)).toBeNull();
    await expect(
      saveStudioVersion(sql, { ownerId: owner, agentId: a.agentId, config: config(), now: NOW + 1 }),
    ).rejects.toMatchObject({ code: 'suspended' });
    const [mine] = await listMyAgents(sql, owner, NOW);
    expect(mine).toMatchObject({
      status: 'suspended',
      pausedReason: 'Suspended by the moderators: test reason',
    });
    // Still counts against the maker's limit; the maker can retire it.
    await retireStudioAgent(sql, owner, a.agentId);
    await expect(mod(a.agentId, 'unsuspend')).rejects.toMatchObject({ code: 'bad_action' });
  });

  it('unsuspending returns to active, or to paused when the version already has enough strikes', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Bouncer', config: config(), now: NOW });
    await mod(a.agentId, 'suspend');
    expect(await mod(a.agentId, 'unsuspend')).toMatchObject({ status: 'active' });

    const b = await createStudioAgent(sql, { ownerId: owner, name: 'Struck', config: config(), now: NOW });
    const m = await playWith(1500, b.agentVersion);
    for (let k = 0; k < STUDIO_LIMITS.strikesToPause; k++)
      await recordStrike(sql, { agentVersion: b.agentVersion, matchId: m.matchId, reason: 'x', now: NOW });
    await mod(b.agentId, 'suspend');
    expect(await mod(b.agentId, 'unsuspend')).toMatchObject({ status: 'paused' });
  });

  it('rename keeps versions, changes the public name, and the old name stays unavailable', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Badname', config: config(), now: NOW });
    expect(await mod(a.agentId, 'rename')).toMatchObject({ name: `Agent-${a.agentId}` });
    expect(await studioNames(sql, [a.agentVersion])).toEqual({
      [a.agentVersion]: { name: `Agent-${a.agentId}`, versionNumber: 1 },
    });
    await expect(
      createStudioAgent(sql, { ownerId: owner, name: 'badname', config: config(), now: NOW }),
    ).rejects.toMatchObject({ code: 'name_taken' });
    await expect(mod(a.agentId, 'rename', 'Jane Doe')).rejects.toMatchObject({ code: 'bad_name' });
    await mod(a.agentId, 'rename', 'Tidy');
    const d = await studioAgentDetail(sql, a.agentId);
    expect(d!.name).toBe('Tidy');
    expect(d!.versions).toHaveLength(1);
    expect(d!.moderation.map((x) => [x.action, x.oldName, x.newName])).toEqual([
      ['rename', 'Badname', `Agent-${a.agentId}`],
      ['rename', `Agent-${a.agentId}`, 'Tidy'],
    ]);
  });

  it('every action is recorded append-only, needs a reason and a moderator, and output has no owner ids', async () => {
    const owner = await newMaker();
    const a = await createStudioAgent(sql, { ownerId: owner, name: 'Logged', config: config(), now: NOW });
    await expect(
      moderateStudioAgent(sql, {
        agentId: a.agentId,
        action: 'suspend',
        reason: ' ',
        moderator: 'x',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'bad_action' });
    await mod(a.agentId, 'retire');
    await expect(mod(a.agentId, 'retire')).rejects.toMatchObject({ code: 'retired' });
    await expect(
      sql.query(`update studio_moderation set reason = 'edited' where agent_id = $1`, [a.agentId]),
    ).rejects.toThrow(/append-only/);
    await expect(sql.query('delete from studio_moderation where agent_id = $1', [a.agentId])).rejects.toThrow(
      /append-only/,
    );
    const recent = await recentStudioVersions(sql, NOW - 1);
    expect(recent.some((r) => r.name === 'Logged')).toBe(true);
    const detail = await studioAgentDetail(sql, a.agentId);
    expect(JSON.stringify([recent, detail])).not.toMatch(/p_[0-9a-f]{8}/);
    expect(JSON.stringify([recent, detail])).not.toContain(owner);
  });
});
