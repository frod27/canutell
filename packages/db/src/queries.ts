import type { MatchInput } from '@canutell/engine';
import type { MatchEvent, RevealView, SeatId } from '@canutell/protocol';
import { deriveRows, type DerivedRows } from './derive';
import { deriveIntegrity, type IntegrityRow, type IntegritySeat } from './integrity';
import type { Sql } from './sql';
import type {
  AnnotationRecord,
  ClientSignalRecord,
  ConnectionRecord,
  MatchStatus,
  RejectionRecord,
  StoredClientEnv,
  TimingRecord,
} from './types';

// Reads and rebuilds. Writes during a live match go through PostgresStore.

export const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ms(v));
const json = (v: unknown): string => JSON.stringify(v);

/** Multi-row insert. `cols` maps column → optional cast, e.g. { payload: 'jsonb' }. */
export async function insertRows(
  sql: Sql,
  table: string,
  cols: Record<string, string | null>,
  rows: readonly object[],
): Promise<void> {
  const names = Object.keys(cols);
  const CHUNK = Math.max(1, Math.floor(30_000 / names.length));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const ph = names.map((c) => {
        params.push((row as Record<string, unknown>)[c] ?? null);
        const cast = cols[c];
        return `$${params.length}${cast ? `::${cast}` : ''}`;
      });
      return `(${ph.join(', ')})`;
    });
    await sql.query(`insert into ${table} (${names.join(', ')}) values ${tuples.join(', ')}`, params);
  }
}

// ---------- loading the log back ----------

export interface LoadedMatch {
  matchId: string;
  status: MatchStatus;
  seed: string;
  flags: string[];
  isParty: boolean;
  events: MatchEvent[];
  inputs: MatchInput[];
  timings: TimingRecord[];
  connections: ConnectionRecord[];
  rejections: RejectionRecord[];
  annotations: AnnotationRecord[];
  clientSignals: ClientSignalRecord[];
}

export async function loadMatch(sql: Sql, matchId: string): Promise<LoadedMatch | null> {
  const [m] = await sql.query<{ status: MatchStatus; seed: string; flags: string[]; is_party: boolean }>(
    'select status, seed, flags, is_party from matches where match_id = $1',
    [matchId],
  );
  if (!m) return null;
  const events = await sql.query<{
    seq: number;
    type: string;
    seat_id: number | null;
    payload: unknown;
    server_ts: unknown;
  }>('select seq, type, seat_id, payload, server_ts from events where match_id = $1 order by seq', [matchId]);
  const inputs = await sql.query<{ kind: 'advance' | 'action'; action: unknown; now_ms: number }>(
    'select kind, action, now_ms from match_inputs where match_id = $1 order by idx',
    [matchId],
  );
  const timings = await sql.query<Record<string, unknown>>(
    'select * from decision_timings where match_id = $1 order by seq',
    [matchId],
  );
  const connections = await sql.query<Record<string, unknown>>(
    'select seat_id, state, at from connections where match_id = $1 order by idx',
    [matchId],
  );
  const rejections = await sql.query<Record<string, unknown>>(
    'select seat_id, at, code, engine_code, action_type from rejections where match_id = $1 order by idx',
    [matchId],
  );
  const annotations = await sql.query<{ seq: number; seat_id: number; confidence: number }>(
    'select seq, seat_id, confidence from agent_annotations where match_id = $1 order by seq',
    [matchId],
  );
  const signals = await sql.query<{
    seat_id: number;
    at: unknown;
    kind: ClientSignalRecord['kind'];
    value: unknown;
  }>('select seat_id, at, kind, value from client_signals where match_id = $1 order by idx', [matchId]);
  return {
    matchId,
    status: m.status,
    seed: m.seed,
    flags: m.flags,
    isParty: m.is_party,
    events: events.map(
      (e) =>
        ({
          matchId,
          seq: e.seq,
          type: e.type,
          seat: e.seat_id,
          serverTs: ms(e.server_ts),
          payload: e.payload,
        }) as MatchEvent,
    ),
    inputs: inputs.map((i) =>
      i.kind === 'advance'
        ? { kind: 'advance', now: i.now_ms }
        : ({ kind: 'action', action: i.action, now: i.now_ms } as MatchInput),
    ),
    timings: timings.map((t) => ({
      seq: t.seq as number,
      seat: t.seat_id as SeatId,
      kind: t.kind as TimingRecord['kind'],
      promptKey: t.prompt_key as string,
      timedOut: t.timed_out as boolean,
      promptSentAt: msOrNull(t.prompt_sent_at),
      receivedAt: msOrNull(t.received_at),
      latencyMs: (t.latency_ms as number | null) ?? null,
      clientSentAt: (t.client_sent_at as number | null) ?? null,
    })),
    connections: connections.map((c) => ({
      seat: c.seat_id as SeatId,
      state: c.state as ConnectionRecord['state'],
      at: ms(c.at),
    })),
    rejections: rejections.map((r) => ({
      seat: r.seat_id as SeatId,
      at: ms(r.at),
      code: r.code as string,
      engineCode: (r.engine_code as string | null) ?? null,
      actionType: r.action_type as string,
    })),
    annotations: annotations.map((a) => ({
      seq: a.seq,
      seat: a.seat_id as SeatId,
      confidence: a.confidence,
    })),
    clientSignals: signals.map((c) => ({
      seat: c.seat_id as SeatId,
      at: ms(c.at),
      kind: c.kind,
      value: (c.value as StoredClientEnv | null) ?? null,
    })),
  };
}

/** Seats as the integrity derivation needs them: kind, trust at match time, and whether the account is gone. */
export async function integritySeats(sql: Sql, matchId: string): Promise<IntegritySeat[]> {
  const rows = await sql.query<{
    seat_id: number;
    kind: IntegritySeat['kind'];
    trust_level_at_match: IntegritySeat['trustLevel'];
    deleted: boolean;
  }>(
    `select s.seat_id, s.kind, s.trust_level_at_match, (p.deleted_at is not null) as deleted
       from seats s left join players p on p.player_id = s.player_id
      where s.match_id = $1 order by s.seat_id`,
    [matchId],
  );
  return rows.map((r) => ({
    seat: r.seat_id as SeatId,
    kind: r.kind,
    trustLevel: r.trust_level_at_match,
    deleted: r.deleted,
  }));
}

// ---------- derived tables ----------

const DERIVED = ['decisions', 'stakes', 'messages', 'ballots', 'seat_results', 'integrity_signals'] as const;

/**
 * Replace one match's derived rows with a fresh derivation from its log, in one transaction. That includes
 * integrity_signals (SPEC §Integrity). Trust changes are NOT re-applied here: they happen once, at match end
 * (applyMatchTrust).
 */
export async function rebuildDerived(
  sql: Sql,
  matchId: string,
): Promise<DerivedRows & { integrity: IntegrityRow[] }> {
  return sql.transaction(async (tx) => {
    const m = await loadMatch(tx, matchId);
    if (!m) throw new Error(`no match ${matchId}`);
    const rows = deriveRows(matchId, m.events, m.timings, m.annotations);
    const integrity = deriveIntegrity({
      seats: await integritySeats(tx, matchId),
      events: m.events,
      timings: m.timings,
      clientSignals: m.clientSignals,
    });
    for (const t of DERIVED) await tx.query(`delete from ${t} where match_id = $1`, [matchId]);
    const withId = <T extends object>(r: T) => ({ match_id: matchId, ...r });
    await insertRows(
      tx,
      'decisions',
      {
        match_id: null,
        seq: null,
        round: null,
        seat_id: null,
        phase: null,
        kind: null,
        option_set: 'jsonb',
        chosen: 'jsonb',
        confidence: null,
        timed_out: null,
        latency_ms: null,
        prompt_seen: null,
        state_hash: null,
      },
      rows.decisions.map((d) => withId({ ...d, option_set: json(d.option_set), chosen: json(d.chosen) })),
    );
    await insertRows(
      tx,
      'stakes',
      {
        match_id: null,
        stake_id: null,
        seq: null,
        round: null,
        from_seat: null,
        to_seat: null,
        sent: null,
        received: null,
        returned: null,
        return_timed_out: null,
      },
      rows.stakes.map(withId),
    );
    await insertRows(
      tx,
      'messages',
      {
        match_id: null,
        seq: null,
        round: null,
        phase: null,
        from_seat: null,
        channel: null,
        to_seat: null,
        text: null,
        masked: null,
        sent_at: 'timestamptz',
        typing_ms: null,
        pasted: null,
      },
      rows.messages.map((r) => withId({ ...r, sent_at: iso(r.sent_at) })),
    );
    await insertRows(
      tx,
      'ballots',
      {
        match_id: null,
        voter_seat: null,
        target_seat: null,
        label: null,
        confidence: null,
        payoff: null,
        applied: null,
      },
      rows.ballots.map(withId),
    );
    await insertRows(
      tx,
      'seat_results',
      {
        match_id: null,
        seat_id: null,
        exiled_round: null,
        coins_before_reveal: null,
        delay_paid: null,
        exile_bonus: null,
        ballot_payoff: null,
        final_score: null,
      },
      rows.seatResults.map(withId),
    );
    await insertRows(
      tx,
      'integrity_signals',
      { match_id: null, seat_id: null, signal: null, value: null, flagged: null },
      integrity.map(withId),
    );
    return { ...rows, integrity };
  });
}

/** Rebuild every match's derived rows. Returns how many matches were rebuilt. */
export async function rebuildAllDerived(
  sql: Sql,
  onError?: (matchId: string, e: unknown) => void,
): Promise<number> {
  const ids = await sql.query<{ match_id: string }>('select match_id from matches order by created_at');
  let n = 0;
  for (const { match_id } of ids) {
    try {
      await rebuildDerived(sql, match_id);
      n++;
    } catch (e) {
      onError?.(match_id, e);
    }
  }
  return n;
}

// ---------- reveal, from derived tables (SPEC §Reveal) ----------

export interface StakeSummary {
  stakeId: string;
  round: number;
  from: SeatId;
  to: SeatId;
  sent: number;
  received: number;
  returned: number | null;
}

/** The seat a player held in a match, or null. Used to authorize reveal reads. */
export async function seatOfPlayer(sql: Sql, matchId: string, playerId: string): Promise<SeatId | null> {
  const [r] = await sql.query<{ seat_id: number }>(
    'select seat_id from seats where match_id = $1 and player_id = $2',
    [matchId, playerId],
  );
  return r ? (r.seat_id as SeatId) : null;
}

/**
 * Builds the reveal from derived tables. For a completed match it must equal the engine's own
 * `viewFor(state, seat).reveal` exactly — tested for every load-test match, which cross-checks the
 * derivation end to end.
 */
export async function revealFromDb(sql: Sql, matchId: string): Promise<RevealView | null> {
  const [m] = await sql.query<{ status: MatchStatus }>('select status from matches where match_id = $1', [
    matchId,
  ]);
  if (!m || m.status !== 'completed') return null;
  const seats = await sql.query<{ seat_id: number; is_agent: boolean; agent_version: string | null }>(
    'select seat_id, is_agent, agent_version from seats where match_id = $1 order by seat_id',
    [matchId],
  );
  const results = await sql.query<Record<string, number | null>>(
    'select * from seat_results where match_id = $1 order by seat_id',
    [matchId],
  );
  const ballots = await sql.query<{
    voter_seat: number;
    target_seat: number;
    label: 'agent' | 'human' | null;
    confidence: number | null;
    payoff: number;
    applied: boolean;
  }>('select * from ballots where match_id = $1 order by voter_seat, target_seat', [matchId]);
  const decisions = await sql.query<{
    seq: number;
    round: number;
    seat_id: number;
    kind: string;
    chosen: { target?: number | null };
    timed_out: boolean;
  }>(
    `select seq, round, seat_id, kind, chosen, timed_out from decisions
      where match_id = $1 and kind in ('vote', 'ballot') order by seq`,
    [matchId],
  );
  const stakes = await sql.query<{
    stake_id: string;
    round: number;
    from_seat: number;
    to_seat: number;
    sent: number;
    returned: number | null;
  }>(
    'select stake_id, round, from_seat, to_seat, sent, returned from stakes where match_id = $1 order by seq',
    [matchId],
  );
  if (results.length !== 6 || seats.length !== 6) return null;

  const isAgent = seats.map((s) => s.is_agent);
  const revealSeats = seats.map((s, i) => {
    const r = results[i]!;
    const labeled = ballots.filter((b) => b.voter_seat === s.seat_id && b.label !== null);
    return {
      seatId: s.seat_id as SeatId,
      isAgent: s.is_agent,
      agentVersion: s.agent_version,
      exiledRound: r.exiled_round ?? null,
      coinsBeforeReveal: r.coins_before_reveal!,
      delayPaid: r.delay_paid!,
      exileBonus: r.exile_bonus!,
      ballotPayoff: r.ballot_payoff!,
      finalScore: r.final_score!,
      ballotAccuracy: {
        labeled: labeled.length,
        correct: labeled.filter((b) => (b.label === 'agent') === isAgent[b.target_seat]).length,
      },
    };
  });
  const ballotDecision = new Map(decisions.filter((d) => d.kind === 'ballot').map((d) => [d.seat_id, d]));
  const revealBallots = seats.map((s) => ({
    voter: s.seat_id as SeatId,
    timedOut: ballotDecision.get(s.seat_id)?.timed_out ?? true,
    labels: ballots
      .filter((b) => b.voter_seat === s.seat_id && b.label !== null)
      .map((b) => ({
        target: b.target_seat as SeatId,
        label: b.label!,
        confidence: b.confidence!,
        payoff: b.payoff,
        applied: b.applied,
      })),
  }));
  const voteRounds = [...new Set(decisions.filter((d) => d.kind === 'vote').map((d) => d.round))].sort(
    (a, b) => a - b,
  );
  const votes = voteRounds.map((round) => {
    const cast = decisions
      .filter((d) => d.kind === 'vote' && d.round === round)
      .sort((a, b) => a.seat_id - b.seat_id)
      .map((d) => ({
        voter: d.seat_id as SeatId,
        target: (d.chosen.target ?? null) as SeatId | null,
        timedOut: d.timed_out,
      }));
    const tally = [0, 0, 0, 0, 0, 0];
    for (const c of cast) if (c.target !== null) tally[c.target]!++;
    const exiled = revealSeats.find((s) => s.exiledRound === round)?.seatId ?? null;
    return { round, exiled, tally, ballots: cast };
  });
  const stakeView = (s: (typeof stakes)[number]) => ({
    stakeId: s.stake_id,
    round: s.round,
    from: s.from_seat as SeatId,
    to: s.to_seat as SeatId,
    sent: s.sent,
    returned: s.returned ?? 0,
  });
  let biggest: (typeof stakes)[number] | null = null;
  for (const s of stakes) if (!biggest || s.sent > biggest.sent) biggest = s;
  return {
    seats: revealSeats,
    ballots: revealBallots,
    votes,
    keyMoments: {
      biggestStake: biggest ? stakeView(biggest) : null,
      unreturnedStakes: stakes.filter((s) => (s.returned ?? 0) === 0).map(stakeView),
      exiles: revealSeats
        .filter((s) => s.exiledRound !== null)
        .map((s) => ({ round: s.exiledRound!, seat: s.seatId, isAgent: s.isAgent }))
        .sort((a, b) => a.round - b.round),
    },
  };
}

export async function stakesForSeat(sql: Sql, matchId: string, seat: SeatId): Promise<StakeSummary[]> {
  const rows = await sql.query<{
    stake_id: string;
    round: number;
    from_seat: number;
    to_seat: number;
    sent: number;
    received: number;
    returned: number | null;
  }>(
    `select stake_id, round, from_seat, to_seat, sent, received, returned from stakes
      where match_id = $1 and (from_seat = $2 or to_seat = $2) order by seq`,
    [matchId, seat],
  );
  return rows.map((r) => ({
    stakeId: r.stake_id,
    round: r.round,
    from: r.from_seat as SeatId,
    to: r.to_seat as SeatId,
    sent: r.sent,
    received: r.received,
    returned: r.returned,
  }));
}

// ---------- privacy deletion (the only code allowed to remove log rows) ----------

/**
 * Deletes whole matches (log, derived rows, seats) that carry `flag`, then the players who sat in them and
 * have no seat left, with everything about them (identity, passkeys, sessions, consents, trust history).
 * The append-only triggers allow this only because the transaction sets canutell.privacy_deletion.
 * Used to purge pre-alpha dev data before the closed alpha (DECISIONS "Guest data before accounts").
 */
export async function purgeMatchesWithFlag(
  sql: Sql,
  flag: string,
): Promise<{ matches: number; players: number }> {
  return sql.transaction(async (tx) => {
    await tx.exec(`set local canutell.privacy_deletion = 'on'`);
    const sat = await tx.query<{ player_id: string }>(
      `select distinct s.player_id from seats s join matches m using (match_id)
        where $1 = any(m.flags) and s.player_id is not null`,
      [flag],
    );
    const deleted = await tx.query<{ match_id: string }>(
      'delete from matches where $1 = any(flags) returning match_id',
      [flag],
    );
    const orphans = (
      await tx.query<{ player_id: string }>(
        `select p.player_id from players p
          where p.player_id = any($1::text[])
            and not exists (select 1 from seats s where s.player_id = p.player_id)`,
        [sat.map((r) => r.player_id)],
      )
    ).map((r) => r.player_id);
    for (const t of ['identity.identities', 'consents', 'trust_changes'])
      await tx.query(`delete from ${t} where player_id = any($1::text[])`, [orphans]);
    await tx.query('delete from players where player_id = any($1::text[])', [orphans]);
    return { matches: deleted.length, players: orphans.length };
  });
}
