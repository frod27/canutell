import { ballotPayoff } from '@canutell/engine';
import type { EventOf, MatchEvent, SeatId } from '@canutell/protocol';
import type { AnnotationRecord, TimingRecord } from './types';

// Derived tables are a pure function of the log (CLAUDE.md invariant 8): events + server timings in,
// rows out. Same input → same rows, so derive() can be rerun at any time. It is strict: anything
// inconsistent in the log throws instead of producing a plausible-looking row.

export interface DecisionRow {
  seq: number;
  round: number;
  seat_id: SeatId;
  phase: string;
  kind: string;
  option_set: unknown;
  chosen: unknown;
  confidence: number | null;
  timed_out: boolean;
  latency_ms: number | null;
  prompt_seen: boolean;
  state_hash: string;
}

export interface StakeRow {
  stake_id: string;
  seq: number;
  round: number;
  from_seat: SeatId;
  to_seat: SeatId;
  sent: number;
  received: number;
  returned: number | null;
  return_timed_out: boolean | null;
}

export interface MessageRow {
  seq: number;
  round: number;
  phase: string;
  from_seat: SeatId;
  channel: 'table' | 'dm' | 'exile';
  to_seat: SeatId | null;
  text: string;
  masked: boolean;
  sent_at: number;
  typing_ms: number | null;
  pasted: boolean | null;
}

export interface BallotRow {
  voter_seat: SeatId;
  target_seat: SeatId;
  label: 'agent' | 'human' | null;
  confidence: number | null;
  payoff: number;
  applied: boolean;
}

export interface SeatResultRow {
  seat_id: SeatId;
  exiled_round: number | null;
  coins_before_reveal: number;
  delay_paid: number;
  exile_bonus: number;
  ballot_payoff: number;
  final_score: number;
}

export interface DerivedRows {
  decisions: DecisionRow[];
  stakes: StakeRow[];
  messages: MessageRow[];
  ballots: BallotRow[];
  /** Empty unless the match reached Reveal. */
  seatResults: SeatResultRow[];
}

export class DerivationError extends Error {
  constructor(matchId: string, message: string) {
    super(`derive(${matchId}): ${message}`);
    this.name = 'DerivationError';
  }
}

type Ev<T extends MatchEvent['type']> = EventOf<T>;

export function deriveRows(
  matchId: string,
  events: readonly MatchEvent[],
  timings: readonly TimingRecord[],
  annotations: readonly AnnotationRecord[] = [],
): DerivedRows {
  const fail = (m: string): never => {
    throw new DerivationError(matchId, m);
  };
  events.forEach((e, i) => {
    if (e.seq !== i) fail(`event seq ${e.seq} at position ${i}: the log has a gap or is out of order`);
  });
  const of = <T extends MatchEvent['type']>(t: T) => events.filter((e): e is Ev<T> => e.type === t);
  const created = of('match_created')[0] ?? fail('no match_created event');
  const isAgent = created.payload.seats.map((s) => s.isAgent);

  // ---- decisions (latency and prompt delivery from the server's timing log) ----
  const timingBySeq = new Map(timings.map((t) => [t.seq, t]));
  const confidenceBySeq = new Map(annotations.map((a) => [a.seq, a]));
  const decisions: DecisionRow[] = of('decision').map((e) => {
    const p = e.payload;
    const t = timingBySeq.get(e.seq) ?? fail(`decision seq ${e.seq} has no timing record`);
    if (t.seat !== e.seat || t.kind !== p.kind || t.timedOut !== p.timedOut)
      fail(`timing for seq ${e.seq} disagrees with the event`);
    return {
      seq: e.seq,
      round: p.round,
      seat_id: e.seat!,
      phase: p.phase,
      kind: p.kind,
      option_set: p.optionSet,
      chosen: p.chosen,
      confidence: (() => {
        const a = confidenceBySeq.get(e.seq);
        if (!a) return null;
        if (a.seat !== e.seat || !isAgent[e.seat!])
          fail(`annotation for seq ${e.seq} is not from that decision's agent seat`);
        return a.confidence;
      })(),
      timed_out: p.timedOut,
      latency_ms: t.latencyMs,
      prompt_seen: t.promptSentAt !== null,
      state_hash: p.stateHash,
    };
  });
  if (timings.length !== decisions.length)
    fail(`${timings.length} timing records for ${decisions.length} decisions`);

  // ---- stakes ----
  const stakes = new Map<string, StakeRow>();
  for (const e of of('stake_sent')) {
    const p = e.payload;
    stakes.set(p.stakeId, {
      stake_id: p.stakeId,
      seq: e.seq,
      round: p.round,
      from_seat: p.from,
      to_seat: p.to,
      sent: p.amount,
      received: p.amount,
      returned: null,
      return_timed_out: null,
    });
  }
  for (const e of of('stake_multiplied')) {
    const s = stakes.get(e.payload.stakeId) ?? fail(`stake_multiplied for unknown ${e.payload.stakeId}`);
    s.received += e.payload.created;
  }
  for (const e of of('stake_returned')) {
    const s = stakes.get(e.payload.stakeId) ?? fail(`stake_returned for unknown ${e.payload.stakeId}`);
    if (s.returned !== null) fail(`stake ${s.stake_id} settled twice`);
    s.returned = e.payload.amount;
    s.return_timed_out = e.payload.timedOut;
  }

  // ---- messages (already masked by the engine) ----
  const messages: MessageRow[] = of('chat_message').map((e) => ({
    seq: e.seq,
    round: e.payload.round,
    phase: e.payload.phase,
    from_seat: e.seat!,
    channel: e.payload.channel,
    to_seat: e.payload.to,
    text: e.payload.text,
    masked: e.payload.masked,
    sent_at: e.serverTs,
    typing_ms: e.payload.client?.typingMs ?? null,
    pasted: e.payload.client?.pasted ?? null,
  }));

  // ---- ballots: one row per (voter, target), blanks explicit ----
  const scored = new Map(of('ballot_scored').map((e) => [`${e.seat}:${e.payload.target}`, e.payload]));
  const ballots: BallotRow[] = [];
  for (const e of of('decision')) {
    const p = e.payload;
    if (p.kind !== 'ballot') continue;
    const voter = e.seat!;
    const given = new Map(p.chosen.labels.map((l) => [l.target, l]));
    for (const target of p.optionSet.targets) {
      const l = given.get(target);
      if (!l) {
        ballots.push({
          voter_seat: voter,
          target_seat: target,
          label: null,
          confidence: null,
          payoff: 0,
          applied: !isAgent[voter],
        });
        continue;
      }
      const s = scored.get(`${voter}:${target}`);
      const payoff = ballotPayoff(l.label, l.confidence, isAgent[target]!);
      if (s && (s.payoff !== payoff || s.applied !== !isAgent[voter]))
        fail(`ballot_scored ${voter}→${target} disagrees with the rule`);
      ballots.push({
        voter_seat: voter,
        target_seat: target,
        label: l.label,
        confidence: l.confidence,
        payoff,
        applied: !isAgent[voter],
      });
    }
  }

  // ---- seat results (only once the match reached Reveal) ----
  const seatResults: SeatResultRow[] = [];
  const ended = of('match_ended')[0];
  if (ended) {
    const sum = (rows: { seat: SeatId | null; v: number }[], seat: number) =>
      rows.filter((r) => r.seat === seat).reduce((a, r) => a + r.v, 0);
    const delays = of('delay_paid').map((e) => ({ seat: e.seat, v: e.payload.created }));
    const bonuses = of('exile_bonus').map((e) => ({ seat: e.seat, v: e.payload.delta }));
    const payoffs = of('ballot_scored').map((e) => ({
      seat: e.seat,
      v: e.payload.applied ? e.payload.payoff : 0,
    }));
    const exiled = new Map(of('seat_exiled').map((e) => [e.seat!, e.payload.round]));
    ended.payload.finalScores.forEach((final, seat) => {
      const delay = sum(delays, seat);
      const bonus = sum(bonuses, seat);
      const ballot = sum(payoffs, seat);
      seatResults.push({
        seat_id: seat as SeatId,
        exiled_round: exiled.get(seat as SeatId) ?? null,
        coins_before_reveal: final - delay - bonus - ballot,
        delay_paid: delay,
        exile_bonus: bonus,
        ballot_payoff: ballot,
        final_score: final,
      });
    });
  }

  return {
    decisions,
    stakes: [...stakes.values()].sort((a, b) => a.seq - b.seq),
    messages,
    ballots,
    seatResults,
  };
}
