import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replay, viewFor } from '@canutell/engine';
import {
  PostgresStore,
  canonicalJson,
  loadMatch,
  purgeMatchesWithFlag,
  rebuildAllDerived,
  rebuildDerived,
  revealFromDb,
  seatOfPlayer,
  stakesForSeat,
  type Sql,
} from '../src';
import { feed, freshDb, metaFor, playerIdFor, simMatch } from './helpers';

let sql: Sql;
let done: () => Promise<void>;
beforeAll(async () => {
  ({ sql, done } = await freshDb());
});
afterAll(() => done());

const errors: unknown[] = [];
const store = () => new PostgresStore(sql, { onError: (_id, e) => errors.push(e), retryDelaysMs: [5, 10] });

describe('PostgresStore — the log round-trips exactly', () => {
  const N = 6;
  const sims = Array.from({ length: N }, (_, i) => simMatch(100 + i, i % 2 ? 'full' : 'quick'));
  const states: Awaited<ReturnType<typeof feed>>[] = [];

  beforeAll(async () => {
    const s = store();
    for (const [i, r] of sims.entries()) states.push(await feed(s, r, metaFor(r, 100 + i)));
    await s.drain();
  });

  it('wrote everything without errors', () => {
    expect(errors).toEqual([]);
  });

  it('events read back equal the engine log (canonical JSON: jsonb reorders keys)', async () => {
    for (const r of sims) {
      const m = (await loadMatch(sql, r.config.matchId))!;
      expect(m.status).toBe('completed');
      expect(canonicalJson(m.events)).toBe(canonicalJson(r.events));
    }
  });

  it('replaying the stored inputs reproduces the stored events (CLAUDE.md invariant 1)', async () => {
    for (const r of sims) {
      const m = (await loadMatch(sql, r.config.matchId))!;
      const again = replay(r.config, m.seed, m.inputs);
      expect(canonicalJson(again.events)).toBe(canonicalJson(m.events));
    }
  });

  it('the reveal built from derived tables equals the engine reveal (cross-check of derive)', async () => {
    for (let i = 0; i < N; i++) {
      const r = sims[i]!;
      const fromDb = await revealFromDb(sql, r.config.matchId);
      expect(canonicalJson(fromDb)).toBe(canonicalJson(viewFor(states[i]!, 0).reveal));
    }
  });

  it('derived rows reconcile with the log', async () => {
    for (const r of sims) {
      const id = r.config.matchId;
      const [{ n: decisions }] = (await sql.query<{ n: number }>(
        'select count(*)::int n from decisions where match_id = $1',
        [id],
      )) as [{ n: number }];
      expect(decisions).toBe(r.events.filter((e) => e.type === 'decision').length);
      const [{ n: timings }] = (await sql.query<{ n: number }>(
        'select count(*)::int n from decision_timings where match_id = $1',
        [id],
      )) as [{ n: number }];
      expect(timings).toBe(decisions);
      const [{ n: ballots }] = (await sql.query<{ n: number }>(
        'select count(*)::int n from ballots where match_id = $1',
        [id],
      )) as [{ n: number }];
      expect(ballots).toBe(30);
    }
  });

  it('rebuilding derived tables is idempotent', async () => {
    const id = sims[0]!.config.matchId;
    const snapshot = async () =>
      canonicalJson(
        await Promise.all(
          ['decisions', 'stakes', 'messages', 'ballots', 'seat_results'].map((t) =>
            sql.query(`select * from ${t} where match_id = $1 order by 2, 3`, [id]),
          ),
        ),
      );
    const before = await snapshot();
    await rebuildDerived(sql, id);
    await rebuildDerived(sql, id);
    expect(await snapshot()).toBe(before);
    expect(await rebuildAllDerived(sql)).toBe(N);
    expect(await snapshot()).toBe(before);
  });

  it('stores seats, roles and pseudonymous players only', async () => {
    const r = sims[0]!;
    const seats = await sql.query<{
      seat_id: number;
      kind: string;
      player_id: string | null;
      agent_version: string | null;
    }>('select seat_id, kind, player_id, agent_version from seats where match_id = $1 order by seat_id', [
      r.config.matchId,
    ]);
    seats.forEach((s, i) => {
      const cfg = r.config.seats[i]!;
      expect(s.kind).toBe(cfg.isAgent ? 'agent' : 'human');
      expect(s.player_id).toBe(cfg.isAgent ? null : playerIdFor(100, i));
    });
    const [m] = await sql.query<{ reveal_mode: string; flags: string[]; agent_count: number }>(
      'select reveal_mode, flags, agent_count from matches where match_id = $1',
      [r.config.matchId],
    );
    expect(m!.reveal_mode).toBe(states[0]!.revealMode);
    expect(m!.flags).toEqual(['phase3']);
    expect(m!.agent_count).toBe(r.config.seats.filter((s) => s.isAgent).length);
  });

  it('authorizes reveal reads by seat and lists that seat’s stakes', async () => {
    const r = sims[1]!;
    const human = r.config.seats.find((s) => !s.isAgent)!.seatId;
    expect(await seatOfPlayer(sql, r.config.matchId, playerIdFor(101, human))).toBe(human);
    expect(await seatOfPlayer(sql, r.config.matchId, playerIdFor(999, human))).toBeNull();
    const mine = await stakesForSeat(sql, r.config.matchId, human);
    expect(mine.every((s) => s.from === human || s.to === human)).toBe(true);
  });
});

describe('PostgresStore — failure handling', () => {
  it('a match cut off mid-way keeps its log up to the last transition and is marked aborted on recovery', async () => {
    const r = simMatch(200);
    const s = store();
    await feed(s, r, metaFor(r, 200), { close: false, upTo: 40 });
    await s.drain();
    const m = (await loadMatch(sql, r.config.matchId))!;
    expect(m.status).toBe('running');
    expect(m.inputs).toHaveLength(40);
    const replayed = replay(r.config, r.seed, m.inputs);
    expect(canonicalJson(replayed.events)).toBe(canonicalJson(m.events));
    expect(await PostgresStore.recover(sql, 1_700_000_999_000)).toBeGreaterThanOrEqual(1);
    expect((await loadMatch(sql, r.config.matchId))!.status).toBe('aborted');
    expect(await revealFromDb(sql, r.config.matchId)).toBeNull();
  });

  it('retries a failed transaction and keeps order', async () => {
    let failures = 2;
    const flaky: Sql = {
      ...sql,
      query: sql.query.bind(sql),
      exec: sql.exec.bind(sql),
      close: sql.close.bind(sql),
      transaction: (fn) => {
        if (failures-- > 0) return Promise.reject(new Error('connection reset'));
        return sql.transaction(fn);
      },
    };
    const r = simMatch(201);
    const s = new PostgresStore(flaky, { retryDelaysMs: [5, 5, 5], onError: (_i, e) => errors.push(e) });
    await feed(s, r, metaFor(r, 201));
    await s.drain();
    const m = (await loadMatch(sql, r.config.matchId))!;
    expect(m.status).toBe('completed');
    expect(canonicalJson(m.events)).toBe(canonicalJson(r.events));
  });

  it('gives up after the retries, reports it, and never writes later batches out of order', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const broken: Sql = {
      ...sql,
      query: sql.query.bind(sql),
      exec: sql.exec.bind(sql),
      close: sql.close.bind(sql),
      transaction: (fn) => (++calls === 2 ? Promise.reject(new Error('disk full')) : sql.transaction(fn)),
    };
    const r = simMatch(202);
    const s = new PostgresStore(broken, { retryDelaysMs: [], onError: (_i, e) => seen.push(e) });
    await feed(s, r, metaFor(r, 202));
    await s.drain();
    expect(String(seen[0])).toMatch(/disk full/);
    const m = (await loadMatch(sql, r.config.matchId))!;
    // Only the first batch (open + first transition) landed; nothing after the failed one.
    expect(m.inputs).toHaveLength(1);
  });
});

describe('privacy deletion (pre-Phase-5 dev data)', () => {
  it('purges only matches with the flag, with their log and orphaned players', async () => {
    const keep = simMatch(300);
    const drop = simMatch(301);
    const s = store();
    await feed(s, keep, metaFor(keep, 300, ['scripted_agents']));
    await feed(s, drop, metaFor(drop, 301, ['phase3', 'scripted_agents']));
    await s.drain();
    const before = (
      await sql.query<{ n: number }>(`select count(*)::int n from matches where 'phase3' = any(flags)`)
    )[0]!.n;
    const out = await purgeMatchesWithFlag(sql, 'phase3');
    expect(out.matches).toBe(before);
    expect(await loadMatch(sql, drop.config.matchId)).toBeNull();
    expect(await sql.query(`select 1 from events where match_id = $1`, [drop.config.matchId])).toEqual([]);
    expect((await loadMatch(sql, keep.config.matchId))!.events.length).toBe(keep.events.length);
    const keptPlayer = keep.config.seats.find((x) => !x.isAgent);
    if (keptPlayer) {
      expect(
        await sql.query('select 1 from players where player_id = $1', [playerIdFor(300, keptPlayer.seatId)]),
      ).toHaveLength(1);
    }
    await expect(sql.query(`delete from events where match_id = $1`, [keep.config.matchId])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('agent annotations (migration 0002)', () => {
  it('derive fills decisions.confidence for agent seats only, and refuses annotations on human seats', async () => {
    let idx = 400;
    while (!simMatch(idx).config.seats.some((x) => x.isAgent)) idx++;
    const r = simMatch(idx);
    const agentSeat = r.config.seats.find((s) => s.isAgent)!.seatId;
    const humanSeat = r.config.seats.find((s) => !s.isAgent)!.seatId;
    const s = store();
    const meta = metaFor(r, idx);
    await feed(s, r, meta, { close: false });
    const decisions = r.events.filter((e) => e.type === 'decision');
    for (const e of decisions.filter((d) => d.seat === agentSeat)) {
      s.annotation(meta.matchId, { seq: e.seq, seat: agentSeat, confidence: 61 });
    }
    s.close(meta.matchId, 'completed', 1_700_000_100_000);
    await s.drain();
    const rows = await sql.query<{ seat_id: number; confidence: number | null }>(
      'select seat_id, confidence from decisions where match_id = $1',
      [meta.matchId],
    );
    for (const row of rows) expect(row.confidence).toBe(row.seat_id === agentSeat ? 61 : null);
    expect(rows.some((x) => x.confidence === 61)).toBe(true);

    // An annotation on a human seat's decision is a data error: derivation refuses it.
    const humanDecision = decisions.find((d) => d.seat === humanSeat)!;
    await sql.query(
      'insert into agent_annotations (match_id, seq, seat_id, confidence) values ($1, $2, $3, 50)',
      [meta.matchId, humanDecision.seq, humanSeat],
    );
    await expect(rebuildDerived(sql, meta.matchId)).rejects.toThrow(/not from that decision's agent seat/);
    await expect(
      sql.query('delete from agent_annotations where match_id = $1', [meta.matchId]),
    ).rejects.toThrow(/append-only/);
  });

  it('registers baseline-1', async () => {
    expect(await sql.query(`select class from agent_versions where agent_version = 'baseline-1'`)).toEqual([
      { class: 'baseline' },
    ]);
  });
});
