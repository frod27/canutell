import { ballotPayoff, coinDelta, exileOutcome, hashJson } from '@canutell/engine';
import {
  EventSchema,
  GAMBLE_MENUS,
  PHASE_DURATION_MS,
  SEAT_COUNT,
  STARTING_COINS,
  SeatViewSchema,
  type EventOf,
  type MatchEvent,
  type SeatId,
} from '@canutell/protocol';
import { runMatch, type SimMatchOptions, type SimMatchResult } from './match';

// Independent audit of one simulated match. Everything here is re-derived from the event log
// (the way Phase 3's derived tables will be), never read from engine internals, so a bug in the
// engine's own bookkeeping cannot hide itself.

export interface Violation {
  check: string;
  detail: string;
}

const FORBIDDEN_IN_VIEW = /isAgent|agentVersion|agentCount|agent_count|targetIsAgent|sim-bot-/;

type Decision = EventOf<'decision'>;

export function auditMatch(r: SimMatchResult): Violation[] {
  const v: Violation[] = [];
  const fail = (check: string, detail: string) => v.push({ check, detail: `${r.seed}: ${detail}` });

  if (r.engineError) fail(`engine:${r.engineError.invariant}`, r.engineError.message);
  for (const rej of r.rejected)
    fail('prompt_action_rejected', `seat ${rej.seat} ${JSON.stringify(rej.action)} → ${rej.code}`);
  if (r.engineError) return v; // the log is incomplete; nothing else is meaningful

  const ev = r.events;
  const of = <T extends MatchEvent['type']>(t: T) => ev.filter((e): e is EventOf<T> => e.type === t);

  // --- log shape (CLAUDE.md invariant 8) ---
  ev.forEach((e, i) => {
    if (e.seq !== i) fail('event_seq', `event ${i} has seq ${e.seq}`);
    if (i > 0 && e.serverTs < ev[i - 1]!.serverTs) fail('server_ts', `event ${i} goes back in time`);
    if (e.matchId !== r.config.matchId) fail('match_id', `event ${i} has matchId ${e.matchId}`);
  });
  if (ev[0]?.type !== 'match_created') fail('log_shape', 'first event is not match_created');
  if (ev.at(-1)?.type !== 'match_ended') fail('log_shape', 'last event is not match_ended');

  const created = of('match_created')[0]!;
  const roles = created.payload.seats.map((s) => s.isAgent);
  const totalRounds = created.payload.totalRounds;
  const ended = of('match_ended')[0];
  if (!ended) return v;
  const finalScores = ended.payload.finalScores;

  // --- phase structure and timing (SPEC §Match structure) ---
  const deadlines = new Map<string, { startedAt: number; deadline: number }>();
  const expectedPhases: string[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    expectedPhases.push(`${round}:invest`, `${round}:deal`, `${round}:gamble`);
    if (round >= 2) expectedPhases.push(`${round}:vote`);
  }
  expectedPhases.push(`${totalRounds}:final_ballot`);
  const started = of('phase_started').map((e) => {
    const key = `${e.payload.round}:${e.payload.phase}`;
    deadlines.set(key, { startedAt: e.payload.startedAt, deadline: e.payload.deadline });
    if (e.payload.deadline - e.payload.startedAt !== PHASE_DURATION_MS[e.payload.phase])
      fail('phase_duration', `${key} lasts ${e.payload.deadline - e.payload.startedAt}`);
    return key;
  });
  if (started.join() !== expectedPhases.join()) fail('phase_order', started.join(' '));

  // --- coin conservation, rebuilt from the log (SPEC §Coin math) ---
  const bal = Array.from({ length: SEAT_COUNT }, () => STARTING_COINS);
  let pot = 0;
  let net = 0;
  for (const e of ev) {
    net += coinDelta(e);
    switch (e.type) {
      case 'contribution_made':
        bal[e.seat!]! -= e.payload.amount;
        pot += e.payload.amount;
        break;
      case 'pot_multiplied':
        pot += e.payload.created;
        break;
      case 'pot_remainder_burned':
        pot -= e.payload.destroyed;
        break;
      case 'pot_paid':
        for (const s of e.payload.recipients) bal[s]! += e.payload.share;
        pot -= e.payload.share * e.payload.recipients.length;
        if (pot !== 0) fail('pot', `round ${e.payload.round} pot left with ${pot}`);
        break;
      case 'stake_sent':
        bal[e.payload.from]! -= e.payload.amount;
        bal[e.payload.to]! += e.payload.amount;
        break;
      case 'stake_multiplied':
      case 'gamble_won':
      case 'delay_paid':
        bal[e.seat!]! += e.payload.created;
        break;
      case 'stake_returned':
        bal[e.payload.to]! -= e.payload.amount;
        bal[e.payload.from]! += e.payload.amount;
        break;
      case 'exile_bonus':
        bal[e.seat!]! += e.payload.delta;
        break;
      case 'ballot_scored':
        if (e.payload.applied) bal[e.seat!]! += e.payload.payoff;
        break;
    }
    const preReveal = e.type !== 'exile_bonus' && e.type !== 'ballot_scored' && e.type !== 'match_ended';
    if (preReveal && bal.some((b) => b < 0)) fail('non_negative', `negative balance after seq ${e.seq}`);
  }
  if (bal.join() !== finalScores.join()) fail('log_rebuild', `rebuilt ${bal} ≠ final ${finalScores}`);
  const total = finalScores.reduce((a, b) => a + b, 0);
  if (total !== STARTING_COINS * SEAT_COUNT + net) fail('conservation', `Σ final ${total} ≠ 600 + ${net}`);
  if (r.state.seats.some((s, i) => s.balance !== finalScores[i]))
    fail('state_vs_log', 'engine balances ≠ log');

  // --- who was active when (SPEC §Vote) ---
  const exiledRound = Array.from({ length: SEAT_COUNT }, () => null as number | null);
  for (const e of of('seat_exiled')) exiledRound[e.seat!] = e.payload.round;
  const activeIn = (seat: number, round: number) => exiledRound[seat] === null || exiledRound[seat]! >= round;

  // --- decision completeness and timeouts (SPEC §Match structure "Timeouts") ---
  const decisions = of('decision');
  const count = new Map<string, number>();
  for (const d of decisions) {
    const p = d.payload;
    const id = p.kind === 'return' ? `return:${p.optionSet.stakeId}` : `${p.kind}:${p.round}:${d.seat}`;
    count.set(id, (count.get(id) ?? 0) + 1);
    checkDecisionTiming(d, deadlines, fail);
    if (p.timedOut) checkTimeoutDefault(d, fail);
  }
  for (let round = 1; round <= totalRounds; round++) {
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const kinds = round >= 2 ? ['invest', 'stake', 'gamble', 'vote'] : ['invest', 'stake', 'gamble'];
      for (const kind of kinds) {
        const n = count.get(`${kind}:${round}:${seat}`) ?? 0;
        const want = activeIn(seat, round) ? 1 : 0;
        if (n !== want)
          fail('decision_count', `${kind} r${round} seat ${seat}: ${n} decisions, want ${want}`);
      }
    }
  }
  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    const n = count.get(`ballot:${totalRounds}:${seat}`) ?? 0;
    if (n !== 1) fail('decision_count', `seat ${seat} has ${n} ballots`);
  }
  for (const s of of('stake_sent')) {
    if ((count.get(`return:${s.payload.stakeId}`) ?? 0) !== 1) fail('return_count', `${s.payload.stakeId}`);
    const rets = of('stake_returned').filter((x) => x.payload.stakeId === s.payload.stakeId);
    if (rets.length !== 1) fail('return_count', `${s.payload.stakeId} settled ${rets.length} times`);
    const ret = rets[0];
    if (ret && ret.payload.amount > 2 * s.payload.amount) fail('return_range', s.payload.stakeId);
    const created = of('stake_multiplied').find((x) => x.payload.stakeId === s.payload.stakeId);
    if (created?.payload.created !== s.payload.amount) fail('stake_doubling', s.payload.stakeId);
    if (s.payload.amount < 1 || s.payload.amount > 20) fail('stake_range', s.payload.stakeId);
    if (!activeIn(s.payload.to, s.payload.round) || s.payload.to === s.payload.from)
      fail('stake_target', s.payload.stakeId);
  }

  // --- pot math per round (SPEC §Coin math) ---
  for (const m of of('pot_multiplied')) {
    const round = m.payload.round;
    const P = decisions
      .filter((d) => d.payload.kind === 'invest' && d.payload.round === round)
      .reduce((sum, d) => sum + (d.payload.kind === 'invest' ? d.payload.chosen.amount : 0), 0);
    const n = Array.from({ length: SEAT_COUNT }, (_, s) => s).filter((s) => activeIn(s, round)).length;
    const share = Math.floor((P * 16) / (10 * n));
    const burned = of('pot_remainder_burned').find((b) => b.payload.round === round)!.payload.destroyed;
    const paid = of('pot_paid').find((b) => b.payload.round === round)!.payload;
    if (m.payload.pot !== P) fail('pot', `round ${round} pot ${m.payload.pot} ≠ Σ contributions ${P}`);
    if (paid.share !== share || paid.activeCount !== n) fail('pot_share', `round ${round}`);
    if (P + m.payload.created - burned !== n * share) fail('pot_burn', `round ${round}`);
    if (burned < 0 || burned >= n) fail('pot_burn', `round ${round} burned ${burned} with n=${n}`);
    for (const d of decisions) {
      if (d.payload.kind === 'invest' && d.payload.round === round && d.payload.chosen.amount > 20)
        fail('invest_range', `round ${round}`);
    }
  }

  // --- gamble outcomes (SPEC §Gamble) ---
  for (const g of of('gamble_won')) {
    const spec = GAMBLE_MENUS[g.payload.menu][g.payload.option];
    if (spec.kind === 'at_end' || spec.kind === 'at_end_if_not_exiled' || g.payload.created !== spec.amount)
      fail('gamble_amount', `${g.payload.menu}/${g.payload.option} paid ${g.payload.created}`);
  }
  for (const d of of('delay_scheduled')) {
    const paid = of('delay_paid').some((p) => p.seat === d.seat && p.payload.round === d.payload.round);
    const forfeited = of('delay_forfeited').some(
      (p) => p.seat === d.seat && p.payload.round === d.payload.round,
    );
    const shouldForfeit = d.payload.onlyIfNotExiled && exiledRound[d.seat!] !== null;
    if (paid === forfeited || forfeited !== shouldForfeit)
      fail('delay', `seat ${d.seat} round ${d.payload.round}`);
  }

  // --- votes and exile (SPEC §Vote) ---
  for (const res of of('vote_resolved')) {
    const tally = Array.from({ length: SEAT_COUNT }, () => 0);
    for (const d of decisions) {
      if (
        d.payload.kind === 'vote' &&
        d.payload.round === res.payload.round &&
        d.payload.chosen.target !== null
      )
        tally[d.payload.chosen.target]!++;
    }
    if (tally.join() !== res.payload.tally.join()) fail('vote_tally', `round ${res.payload.round}`);
    if (exileOutcome(tally) !== res.payload.exiled) fail('exile_rule', `round ${res.payload.round}`);
  }

  // --- exile bonuses (SPEC §Scoring; DECISIONS "Exile bonus") ---
  const expectedBonus: string[] = [];
  for (const res of of('vote_resolved')) {
    const target = res.payload.exiled;
    if (target === null) continue;
    for (const d of decisions) {
      if (
        d.payload.kind !== 'vote' ||
        d.payload.round !== res.payload.round ||
        d.payload.chosen.target !== target
      )
        continue;
      if (roles[d.seat!]) continue;
      expectedBonus.push(`${d.seat}:${target}:${roles[target] ? 10 : -5}`);
    }
  }
  const actualBonus = of('exile_bonus').map((e) => `${e.seat}:${e.payload.target}:${e.payload.delta}`);
  if (expectedBonus.sort().join() !== actualBonus.sort().join())
    fail('exile_bonus', `${actualBonus} vs ${expectedBonus}`);

  // --- ballots (SPEC §Final ballot, §Scoring) ---
  const scored = of('ballot_scored');
  let labelCount = 0;
  for (const d of decisions) {
    if (d.payload.kind !== 'ballot') continue;
    for (const l of d.payload.chosen.labels) {
      labelCount++;
      const s = scored.find((x) => x.seat === d.seat && x.payload.target === l.target);
      const want = ballotPayoff(l.label, l.confidence, roles[l.target]!);
      if (!s || s.payload.payoff !== want || s.payload.applied !== !roles[d.seat!])
        fail('ballot_payoff', `voter ${d.seat} target ${l.target}`);
    }
  }
  if (labelCount !== scored.length) fail('ballot_payoff', `${scored.length} scored vs ${labelCount} labels`);

  // --- hidden information in views (CLAUDE.md invariants 4, 7) ---
  for (const pv of r.phaseViews) {
    pv.views.forEach((json, seat) => {
      if (FORBIDDEN_IN_VIEW.test(json)) fail('hidden_info', `${pv.key} seat ${seat} view mentions roles`);
      if (!json.includes('"reveal":null'))
        fail('hidden_info', `${pv.key} seat ${seat} has reveal before Reveal`);
    });
  }
  return v;
}

function checkDecisionTiming(
  d: Decision,
  deadlines: Map<string, { startedAt: number; deadline: number }>,
  fail: (check: string, detail: string) => void,
): void {
  const p = d.payload;
  const w = deadlines.get(`${p.round}:${p.phase}`);
  if (!w) return fail('decision_phase', `decision in unknown phase ${p.round}:${p.phase}`);
  if (p.phaseStartedAt !== w.startedAt) fail('decision_phase', `phaseStartedAt mismatch at seq ${d.seq}`);
  if (p.timedOut ? p.decidedAt !== w.deadline : p.decidedAt < w.startedAt || p.decidedAt >= w.deadline)
    fail('decision_timing', `seq ${d.seq} decidedAt ${p.decidedAt} outside ${w.startedAt}..${w.deadline}`);
}

function checkTimeoutDefault(d: Decision, fail: (check: string, detail: string) => void): void {
  const p = d.payload;
  const ok =
    (p.kind === 'invest' && p.chosen.amount === 0) ||
    (p.kind === 'stake' && p.chosen.to === null && p.chosen.amount === 0) ||
    (p.kind === 'return' && p.chosen.amount === 0) ||
    (p.kind === 'gamble' && p.chosen.option === 'A') ||
    (p.kind === 'vote' && p.chosen.target === null) ||
    (p.kind === 'ballot' && p.chosen.labels.length === 0);
  if (!ok) fail('timeout_default', `seq ${d.seq} ${p.kind} timed out with ${JSON.stringify(p.chosen)}`);
}

/** Deep audits for a sample of matches: replay determinism, schema validation, role counterfactuals. */
export function deepAudit(opts: SimMatchOptions, r: SimMatchResult): Violation[] {
  const v: Violation[] = [];
  const fail = (check: string, detail: string) => v.push({ check, detail: `${r.seed}: ${detail}` });

  // CLAUDE.md invariant 1: re-run from the same seed → byte-identical log.
  const again = runMatch(opts);
  if (hashJson(again.events) !== hashJson(r.events))
    fail('determinism', 'second run produced a different log');

  // Every event and view parses against the protocol schemas.
  for (const e of r.events) {
    const res = EventSchema.safeParse(e);
    if (!res.success) fail('schema_event', `seq ${e.seq} ${e.type}: ${res.error.issues[0]?.message}`);
  }
  for (const pv of r.phaseViews) {
    for (const json of pv.views) {
      const res = SeatViewSchema.safeParse(JSON.parse(json));
      if (!res.success) fail('schema_view', `${pv.key}: ${res.error.issues[0]?.message}`);
    }
  }

  // CLAUDE.md invariant 7: the same inputs with different roles (incl. a different agent count)
  // must give byte-identical views until Reveal.
  const drawn = r.config.seats.map((s) => s.isAgent);
  const layouts = [
    Array(SEAT_COUNT).fill(false),
    drawn.map((_, i) => i === 0 || i === 3),
    drawn.map((a) => !a).map((a, i) => a && i < 2),
  ];
  for (const agents of layouts) {
    const cf = runMatch({ ...opts, agentsOverride: agents as boolean[] });
    if (cf.phaseViews.length !== r.phaseViews.length) {
      fail('hidden_info_counterfactual', 'different number of phases');
      continue;
    }
    cf.phaseViews.forEach((pv, i) => {
      pv.views.forEach((json, seat) => {
        if (json !== r.phaseViews[i]!.views[seat])
          fail('hidden_info_counterfactual', `${pv.key} seat ${seat as SeatId} view depends on roles`);
      });
    });
  }
  return v;
}
