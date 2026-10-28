import {
  ActionSchema,
  EXILE_BONUS_AGENT,
  EXILE_BONUS_HUMAN,
  EXILE_MIN_VOTES,
  FIRST_VOTE_ROUND,
  GAMBLE_MENUS,
  INVEST_MAX,
  MatchConfigSchema,
  PHASE_DURATION_MS,
  ROUNDS_BY_MODE,
  RULESET_VERSION,
  SEAT_COUNT,
  STAKE_MAX,
  STAKE_MIN,
  STAKE_MULTIPLIER,
  STARTING_COINS,
  SeedSchema,
  gambleMenuFor,
  type Action,
  type BallotAction,
  type ChatAction,
  type DecisionPayload,
  type EventType,
  type GambleAction,
  type InvestAction,
  type MatchConfig,
  type MatchEvent,
  type PayloadOf,
  type ReturnAction,
  type SeatId,
  type StakeAction,
  type TimedPhase,
  type VoteAction,
} from '@canutell/protocol';
import { ballotPayoff, splitPot } from './coin-math';
import { ActionRejectedError, InvariantViolationError } from './errors';
import { maskChat } from './mask';
import { Rng } from './rng';
import {
  activeSeats,
  cloneState,
  coinsInPlay,
  currentRound,
  isActive,
  type MatchState,
  type RoundState,
  type SeatState,
} from './state';
import { chatPermissions, viewHash } from './view';

export interface Transition {
  state: MatchState;
  events: MatchEvent[];
}

// ---------------------------------------------------------------------------------------------
// Event emission and coin accounting (SPEC §Coin math, CLAUDE.md invariants 3 and 8)
// ---------------------------------------------------------------------------------------------

/** Coins created (+) or destroyed (−) by an event. Every other event moves coins without changing the total. */
export function coinDelta(event: MatchEvent): number {
  switch (event.type) {
    case 'pot_multiplied':
    case 'stake_multiplied':
    case 'gamble_won':
    case 'delay_paid':
      return event.payload.created;
    case 'pot_remainder_burned':
      return -event.payload.destroyed;
    case 'exile_bonus':
      return event.payload.delta;
    case 'ballot_scored':
      return event.payload.applied ? event.payload.payoff : 0;
    default:
      return 0;
  }
}

class Tx {
  readonly events: MatchEvent[] = [];
  constructor(
    readonly state: MatchState,
    readonly now: number,
  ) {}

  emit<T extends EventType>(type: T, seat: SeatId | null, payload: PayloadOf<T>): void {
    const event = {
      matchId: this.state.matchId,
      seq: this.state.seq++,
      type,
      seat,
      serverTs: this.now,
      payload,
    } as MatchEvent;
    const d = coinDelta(event);
    if (d > 0) this.state.ledger.created += d;
    else if (d < 0) this.state.ledger.destroyed -= d;
    this.events.push(event);
  }

  seat(id: SeatId): SeatState {
    return this.state.seats[id]!;
  }
}

/**
 * Runs after every transition. Conservation (SPEC §Coin math): the change in coins in play must equal
 * the sum of coins created minus destroyed by this transition's named events, and the running ledger
 * must balance. Also checks integer, non-negative balances (before Reveal) and contiguous sequence numbers.
 */
export function checkInvariants(prev: MatchState, next: MatchState, events: readonly MatchEvent[]): void {
  let delta = 0;
  for (const e of events) delta += coinDelta(e);
  const before = coinsInPlay(prev);
  const after = coinsInPlay(next);
  if (after - before !== delta) {
    throw new InvariantViolationError(
      'conservation',
      `coins in play changed by ${after - before} but events account for ${delta}`,
    );
  }
  const { initial, created, destroyed } = next.ledger;
  if (after !== initial + created - destroyed) {
    throw new InvariantViolationError(
      'conservation',
      `coins in play ${after} ≠ initial ${initial} + created ${created} − destroyed ${destroyed}`,
    );
  }
  if (!Number.isSafeInteger(next.pot) || next.pot < 0) {
    throw new InvariantViolationError('integer_coins', `pot ${next.pot} is not a non-negative integer`);
  }
  if (next.phase !== 'invest' && next.pot !== 0) {
    throw new InvariantViolationError('conservation', `pot holds ${next.pot} coins outside Invest`);
  }
  for (const s of next.seats) {
    if (!Number.isSafeInteger(s.balance)) {
      throw new InvariantViolationError(
        'integer_coins',
        `seat ${s.seatId} balance ${s.balance} is not an integer`,
      );
    }
    if (next.phase !== 'reveal' && s.balance < 0) {
      throw new InvariantViolationError(
        'non_negative',
        `seat ${s.seatId} balance ${s.balance} < 0 before Reveal`,
      );
    }
  }
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== prev.seq + i) {
      throw new InvariantViolationError(
        'event_seq',
        `event ${i} has seq ${events[i]!.seq}, expected ${prev.seq + i}`,
      );
    }
  }
  if (next.seq !== prev.seq + events.length) {
    throw new InvariantViolationError('event_seq', 'state.seq does not match emitted events');
  }
}

// ---------------------------------------------------------------------------------------------
// createMatch
// ---------------------------------------------------------------------------------------------

function newRound(round: number): RoundState {
  const empty = <T>(): (T | null)[] => Array.from({ length: SEAT_COUNT }, () => null);
  return {
    round,
    menu: gambleMenuFor(round),
    contributions: empty(),
    investResult: null,
    stakes: empty(),
    gambles: empty(),
    gambleOutcomes: empty(),
    votes: empty(),
    voteResult: null,
  };
}

/**
 * SPEC §Match structure. Returns a match in the `lobby` phase. It has no clock, so it emits no events;
 * the first advancePhase(state, now) logs `match_created` and starts round 1 Invest.
 */
export function createMatch(config: MatchConfig, seed: string): Transition {
  const cfg = MatchConfigSchema.parse(config);
  SeedSchema.parse(seed);
  const rng = Rng.fromSeed(seed);
  // SPEC §Match structure: reveal mode drawn per match from the seeded RNG, 50/50.
  const revealMode = rng.nextInt(2) === 0 ? 'individual' : 'aggregate';
  const state: MatchState = {
    rulesetVersion: RULESET_VERSION,
    matchId: cfg.matchId,
    seed,
    mode: cfg.mode,
    isParty: cfg.isParty,
    revealMode,
    totalRounds: ROUNDS_BY_MODE[cfg.mode],
    seats: cfg.seats.map((s) => ({
      seatId: s.seatId,
      isAgent: s.isAgent,
      agentVersion: s.agentVersion,
      balance: STARTING_COINS,
      exiledRound: null,
    })),
    round: 0,
    phase: 'lobby',
    phaseStartedAt: null,
    deadline: null,
    clock: null,
    seq: 0,
    rng: rng.s,
    pot: 0,
    ledger: { initial: STARTING_COINS * SEAT_COUNT, created: 0, destroyed: 0 },
    rounds: [],
    stakes: [],
    delays: [],
    chat: [],
    ballots: Array.from({ length: SEAT_COUNT }, () => null),
    reveal: null,
  };
  return { state, events: [] };
}

// ---------------------------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------------------------

function reject(code: ConstructorParameters<typeof ActionRejectedError>[0], message: string): never {
  throw new ActionRejectedError(code, message);
}

function checkTime(state: MatchState, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) reject('invalid_action', `now must be a non-negative integer`);
  if (state.clock !== null && now < state.clock)
    reject('clock_regression', `now ${now} < last ${state.clock}`);
}

function decisionBase(prev: MatchState, seat: SeatId, decidedAt: number, timedOut: boolean) {
  return {
    round: prev.round,
    phase: prev.phase as TimedPhase,
    timedOut,
    stateHash: viewHash(prev, seat),
    phaseStartedAt: prev.phaseStartedAt!,
    decidedAt,
  };
}

function emitDecision(tx: Tx, seat: SeatId, payload: DecisionPayload): void {
  tx.emit('decision', seat, payload);
}

/**
 * Applies one validated player choice. Throws ActionRejectedError (state unchanged) if the action is
 * malformed, out of phase, late, or not allowed for this seat right now.
 */
export function applyAction(state: MatchState, action: Action, now: number): Transition {
  const parsed = ActionSchema.safeParse(action);
  if (!parsed.success) reject('invalid_action', parsed.error.issues.map((i) => i.message).join('; '));
  const a = parsed.data;
  if (state.phase === 'lobby') reject('match_not_started', 'the match has not started');
  if (state.phase === 'reveal') reject('match_over', 'the match is over');
  checkTime(state, now);
  if (state.deadline !== null && now >= state.deadline)
    reject('late', `deadline ${state.deadline} has passed`);

  const next = cloneState(state);
  next.clock = now;
  const tx = new Tx(next, now);
  switch (a.type) {
    case 'invest':
      doInvest(state, tx, a);
      break;
    case 'stake':
      doStake(state, tx, a);
      break;
    case 'return':
      doReturn(state, tx, a);
      break;
    case 'gamble':
      doGamble(state, tx, a);
      break;
    case 'vote':
      doVote(state, tx, a);
      break;
    case 'ballot':
      doBallot(state, tx, a);
      break;
    case 'chat':
      doChat(state, tx, a);
      break;
  }
  checkInvariants(state, next, tx.events);
  return { state: next, events: tx.events };
}

function requirePhase(state: MatchState, phase: TimedPhase): void {
  if (state.phase !== phase) reject('wrong_phase', `expected ${phase}, match is in ${state.phase}`);
}

function requireActive(state: MatchState, seat: SeatId): void {
  if (!isActive(state, seat)) reject('not_active', `seat ${seat} is exiled`);
}

function otherActive(state: MatchState, seat: SeatId): SeatId[] {
  return activeSeats(state).filter((s) => s !== seat);
}

/** SPEC §Invest: 0–20 coins, capped at balance. Coins move into the escrowed pot immediately. */
function doInvest(prev: MatchState, tx: Tx, a: InvestAction): void {
  requirePhase(prev, 'invest');
  requireActive(prev, a.seat);
  const round = currentRound(tx.state);
  if (round.contributions[a.seat] !== null) reject('already_acted', 'already invested this round');
  const me = tx.seat(a.seat);
  const max = Math.min(INVEST_MAX, me.balance);
  if (a.amount > max) reject('insufficient_balance', `max contribution is ${max}`);
  const base = decisionBase(prev, a.seat, tx.now, false);
  me.balance -= a.amount;
  tx.state.pot += a.amount;
  round.contributions[a.seat] = { value: a.amount, timedOut: false };
  emitDecision(tx, a.seat, {
    ...base,
    kind: 'invest',
    optionSet: { min: 0, max },
    chosen: { amount: a.amount },
  });
  if (a.amount > 0) tx.emit('contribution_made', a.seat, { round: round.round, amount: a.amount });
}

function stakeOptionSet(state: MatchState, seat: SeatId) {
  return {
    targets: otherActive(state, seat),
    min: STAKE_MIN,
    max: Math.min(STAKE_MAX, state.seats[seat]!.balance),
  };
}

/** SPEC §Deal: at most one stake per round, 1–20 coins to one other active player, doubled on arrival. */
function doStake(prev: MatchState, tx: Tx, a: StakeAction): void {
  requirePhase(prev, 'deal');
  requireActive(prev, a.seat);
  const round = currentRound(tx.state);
  if (round.stakes[a.seat] !== null) reject('already_acted', 'already staked (or passed) this round');
  const optionSet = stakeOptionSet(prev, a.seat);
  const base = decisionBase(prev, a.seat, tx.now, false);
  if (a.to === null) {
    round.stakes[a.seat] = { value: { to: null, amount: 0 }, timedOut: false };
    emitDecision(tx, a.seat, { ...base, kind: 'stake', optionSet, chosen: { to: null, amount: 0 } });
    return;
  }
  if (!optionSet.targets.includes(a.to))
    reject('invalid_target', `seat ${a.to} is not another active player`);
  if (a.amount > optionSet.max) reject('insufficient_balance', `max stake is ${optionSet.max}`);
  const stakeId = `r${round.round}s${a.seat}`;
  const received = a.amount * STAKE_MULTIPLIER;
  const returnDeadlineRound = round.round < tx.state.totalRounds ? round.round + 1 : round.round;
  tx.seat(a.seat).balance -= a.amount;
  tx.seat(a.to).balance += received;
  round.stakes[a.seat] = { value: { to: a.to, amount: a.amount }, timedOut: false };
  tx.state.stakes.push({
    stakeId,
    round: round.round,
    from: a.seat,
    to: a.to,
    sent: a.amount,
    received,
    returned: null,
    returnTimedOut: null,
    returnDeadlineRound,
  });
  emitDecision(tx, a.seat, { ...base, kind: 'stake', optionSet, chosen: { to: a.to, amount: a.amount } });
  tx.emit('stake_sent', a.seat, {
    stakeId,
    round: round.round,
    from: a.seat,
    to: a.to,
    amount: a.amount,
    returnDeadlineRound,
  });
  tx.emit('stake_multiplied', a.to, { stakeId, created: received - a.amount });
}

/**
 * SPEC §Deal: the receiver returns 0..2s once per stake, any time before the end of the next Deal
 * (or this Deal in the last round). SPEC §Vote: still allowed after the receiver is exiled.
 * Capped at the receiver's balance (DECISIONS "Return capped at balance").
 */
function doReturn(prev: MatchState, tx: Tx, a: ReturnAction): void {
  const stake = tx.state.stakes.find((s) => s.stakeId === a.stakeId);
  if (!stake) reject('unknown_stake', `no stake ${a.stakeId}`);
  if (stake.to !== a.seat) reject('not_receiver', `seat ${a.seat} did not receive ${a.stakeId}`);
  if (stake.returned !== null) reject('stake_closed', `${a.stakeId} is already settled`);
  if (a.amount > stake.received) reject('out_of_range', `return must be 0..${stake.received}`);
  const me = tx.seat(a.seat);
  const max = Math.min(stake.received, me.balance);
  if (a.amount > max) reject('insufficient_balance', `max return is ${max}`);
  const base = decisionBase(prev, a.seat, tx.now, false);
  me.balance -= a.amount;
  tx.seat(stake.from).balance += a.amount;
  stake.returned = a.amount;
  stake.returnTimedOut = false;
  emitDecision(tx, a.seat, {
    ...base,
    kind: 'return',
    optionSet: { stakeId: stake.stakeId, min: 0, max },
    chosen: { amount: a.amount },
  });
  tx.emit('stake_returned', a.seat, {
    stakeId: stake.stakeId,
    from: stake.from,
    to: stake.to,
    amount: a.amount,
    timedOut: false,
  });
}

/** SPEC §Gamble: one private choice per active player, resolved at the end of the phase. */
function doGamble(prev: MatchState, tx: Tx, a: GambleAction): void {
  requirePhase(prev, 'gamble');
  requireActive(prev, a.seat);
  const round = currentRound(tx.state);
  if (round.gambles[a.seat] !== null) reject('already_acted', 'already chose a gamble this round');
  const base = decisionBase(prev, a.seat, tx.now, false);
  round.gambles[a.seat] = { value: a.option, timedOut: false };
  emitDecision(tx, a.seat, {
    ...base,
    kind: 'gamble',
    optionSet: { menu: round.menu },
    chosen: { option: a.option },
  });
}

/** SPEC §Vote: vote for one other active player, or skip (target null). */
function doVote(prev: MatchState, tx: Tx, a: VoteAction): void {
  requirePhase(prev, 'vote');
  requireActive(prev, a.seat);
  const round = currentRound(tx.state);
  if (round.votes[a.seat] !== null) reject('already_acted', 'already voted this round');
  const targets = otherActive(prev, a.seat);
  if (a.target !== null && !targets.includes(a.target))
    reject('invalid_target', `seat ${a.target} is not another active player`);
  const base = decisionBase(prev, a.seat, tx.now, false);
  round.votes[a.seat] = { value: a.target, timedOut: false };
  emitDecision(tx, a.seat, { ...base, kind: 'vote', optionSet: { targets }, chosen: { target: a.target } });
}

/** SPEC §Final ballot: every seat, exiled or not, labels each other seat; targets left out are blank. */
function doBallot(prev: MatchState, tx: Tx, a: BallotAction): void {
  requirePhase(prev, 'final_ballot');
  if (tx.state.ballots[a.seat] !== null) reject('already_acted', 'ballot already submitted');
  const targets = prev.seats.map((s) => s.seatId).filter((s) => s !== a.seat);
  const seen = new Set<number>();
  for (const l of a.labels) {
    if (!targets.includes(l.target)) reject('invalid_target', `cannot label seat ${l.target}`);
    if (seen.has(l.target)) reject('invalid_target', `seat ${l.target} labeled twice`);
    seen.add(l.target);
  }
  const labels = [...a.labels]
    .sort((x, y) => x.target - y.target)
    .map((l) => ({ target: l.target, label: l.label, confidence: l.confidence }));
  const base = decisionBase(prev, a.seat, tx.now, false);
  tx.state.ballots[a.seat] = { labels, timedOut: false };
  emitDecision(tx, a.seat, { ...base, kind: 'ballot', optionSet: { targets }, chosen: { labels } });
}

/**
 * Chat runs in every phase until Reveal (DECISIONS "Chat window"). Active players use table and DMs to
 * other active players; exiled players only the exile channel (SPEC §Vote). Text is masked before logging.
 */
function doChat(prev: MatchState, tx: Tx, a: ChatAction): void {
  const perms = chatPermissions(prev, a.seat);
  if (!perms.channels.includes(a.channel))
    reject('channel_forbidden', `seat ${a.seat} cannot use ${a.channel}`);
  if (a.channel === 'dm') {
    if (a.to === null || !perms.dmTargets.includes(a.to))
      reject('invalid_target', 'DM target must be another active player');
  } else if (a.to !== null) {
    reject('invalid_target', `${a.channel} messages have no recipient`);
  }
  const trimmed = a.text.trim();
  if (trimmed.length === 0) reject('empty_message', 'message is empty');
  const { text, masked } = maskChat(trimmed);
  const phase = prev.phase as TimedPhase;
  tx.state.chat.push({
    index: tx.state.chat.length,
    round: prev.round,
    phase,
    from: a.seat,
    channel: a.channel,
    to: a.to,
    text,
    at: tx.now,
  });
  tx.emit('chat_message', a.seat, {
    round: prev.round,
    phase,
    channel: a.channel,
    to: a.to,
    text,
    masked,
    client: a.client,
  });
}

// ---------------------------------------------------------------------------------------------
// advancePhase
// ---------------------------------------------------------------------------------------------

/**
 * Handles deadlines. Before the deadline it is a no-op. At or after it, it applies timeouts
 * (SPEC §Match structure "Timeouts"), resolves the phase and starts the next one at `now`.
 * From `lobby` it logs `match_created` and starts round 1 Invest. In `reveal` it does nothing.
 */
export function advancePhase(state: MatchState, now: number): Transition {
  if (state.phase === 'reveal') return { state, events: [] };
  checkTime(state, now);
  if (state.phase !== 'lobby' && now < state.deadline!) return { state, events: [] };

  const next = cloneState(state);
  next.clock = now;
  const tx = new Tx(next, now);

  if (state.phase === 'lobby') {
    tx.emit('match_created', null, {
      rulesetVersion: next.rulesetVersion,
      mode: next.mode,
      isParty: next.isParty,
      revealMode: next.revealMode,
      totalRounds: next.totalRounds,
      seed: next.seed,
      seats: next.seats.map((s) => ({ seatId: s.seatId, isAgent: s.isAgent, agentVersion: s.agentVersion })),
    });
    startPhase(tx, 'invest', 1);
  } else {
    const phase = state.phase as TimedPhase;
    switch (phase) {
      case 'invest':
        resolveInvest(state, tx);
        break;
      case 'deal':
        resolveDeal(state, tx);
        break;
      case 'gamble':
        resolveGamble(state, tx);
        break;
      case 'vote':
        resolveVote(state, tx);
        break;
      case 'final_ballot':
        resolveFinalBallot(state, tx); // emits its own phase_ended before the Reveal events
        break;
    }
    if (phase !== 'final_ballot') tx.emit('phase_ended', null, { round: state.round, phase });
    const upcoming = nextPhase(state);
    if (upcoming.phase === 'reveal') {
      next.phase = 'reveal';
      next.phaseStartedAt = now;
      next.deadline = null;
    } else {
      startPhase(tx, upcoming.phase, upcoming.round);
    }
  }
  checkInvariants(state, next, tx.events);
  return { state: next, events: tx.events };
}

/** SPEC §Match structure: Invest, Deal, Gamble, Vote (from round 2); then Final ballot, then Reveal. */
function nextPhase(state: MatchState): { phase: TimedPhase | 'reveal'; round: number } {
  const r = state.round;
  const last = r >= state.totalRounds;
  switch (state.phase) {
    case 'invest':
      return { phase: 'deal', round: r };
    case 'deal':
      return { phase: 'gamble', round: r };
    case 'gamble':
      if (r >= FIRST_VOTE_ROUND) return { phase: 'vote', round: r };
      return last ? { phase: 'final_ballot', round: r } : { phase: 'invest', round: r + 1 };
    case 'vote':
      return last ? { phase: 'final_ballot', round: r } : { phase: 'invest', round: r + 1 };
    case 'final_ballot':
      return { phase: 'reveal', round: r };
    default:
      throw new Error(`no phase after ${state.phase}`);
  }
}

function startPhase(tx: Tx, phase: TimedPhase, round: number): void {
  const s = tx.state;
  if (round !== s.round) {
    s.rounds.push(newRound(round));
    s.round = round;
  }
  s.phase = phase;
  s.phaseStartedAt = tx.now;
  s.deadline = tx.now + PHASE_DURATION_MS[phase];
  tx.emit('phase_started', null, { round, phase, startedAt: tx.now, deadline: s.deadline });
}

/** The default effect for a seat that did not act, logged with timedOut = true at the deadline. */
function timeoutBase(prev: MatchState, seat: SeatId) {
  return decisionBase(prev, seat, prev.deadline!, true);
}

/** SPEC §Invest + §Coin math "Pot payout". */
function resolveInvest(prev: MatchState, tx: Tx): void {
  const round = currentRound(tx.state);
  const active = activeSeats(tx.state);
  for (const seat of active) {
    if (round.contributions[seat] !== null) continue;
    const max = Math.min(INVEST_MAX, tx.seat(seat).balance);
    round.contributions[seat] = { value: 0, timedOut: true };
    emitDecision(tx, seat, {
      ...timeoutBase(prev, seat),
      kind: 'invest',
      optionSet: { min: 0, max },
      chosen: { amount: 0 },
    });
  }
  const pot = tx.state.pot;
  const contributed = round.contributions.reduce((sum, c) => sum + (c?.value ?? 0), 0);
  if (pot !== contributed) {
    throw new InvariantViolationError('conservation', `pot ${pot} ≠ contributions ${contributed}`);
  }
  const split = splitPot(pot, active.length);
  tx.emit('pot_multiplied', null, { round: round.round, pot, created: split.multiplied });
  tx.state.pot += split.multiplied;
  tx.emit('pot_remainder_burned', null, { round: round.round, destroyed: split.burned });
  tx.state.pot -= split.burned;
  for (const seat of active) {
    tx.seat(seat).balance += split.share;
    tx.state.pot -= split.share;
  }
  tx.emit('pot_paid', null, {
    round: round.round,
    activeCount: active.length,
    share: split.share,
    recipients: active,
  });
  round.investResult = {
    pot,
    activeCount: active.length,
    share: split.share,
    multiplied: split.multiplied,
    burned: split.burned,
  };
  tx.emit('invest_revealed', null, {
    round: round.round,
    revealMode: tx.state.revealMode,
    pot,
    share: split.share,
    contributions:
      tx.state.revealMode === 'individual'
        ? round.contributions.flatMap((c, seat) => (c ? [{ seat, amount: c.value }] : []))
        : null,
  });
}

/** SPEC §Deal: no stake by the deadline = no stake; stakes whose window ends now return 0 (timed out). */
function resolveDeal(prev: MatchState, tx: Tx): void {
  const round = currentRound(tx.state);
  for (const seat of activeSeats(tx.state)) {
    if (round.stakes[seat] !== null) continue;
    round.stakes[seat] = { value: { to: null, amount: 0 }, timedOut: true };
    emitDecision(tx, seat, {
      ...timeoutBase(prev, seat),
      kind: 'stake',
      optionSet: stakeOptionSet(prev, seat),
      chosen: { to: null, amount: 0 },
    });
  }
  for (const stake of tx.state.stakes) {
    if (stake.returned !== null || stake.returnDeadlineRound !== round.round) continue;
    const max = Math.min(stake.received, tx.seat(stake.to).balance);
    stake.returned = 0;
    stake.returnTimedOut = true;
    emitDecision(tx, stake.to, {
      ...timeoutBase(prev, stake.to),
      kind: 'return',
      optionSet: { stakeId: stake.stakeId, min: 0, max },
      chosen: { amount: 0 },
    });
    tx.emit('stake_returned', stake.to, {
      stakeId: stake.stakeId,
      from: stake.from,
      to: stake.to,
      amount: 0,
      timedOut: true,
    });
  }
}

/** SPEC §Gamble: timeouts take option A; outcomes drawn from the seeded RNG in seat order. */
function resolveGamble(prev: MatchState, tx: Tx): void {
  const round = currentRound(tx.state);
  const active = activeSeats(tx.state);
  for (const seat of active) {
    if (round.gambles[seat] !== null) continue;
    round.gambles[seat] = { value: 'A', timedOut: true };
    emitDecision(tx, seat, {
      ...timeoutBase(prev, seat),
      kind: 'gamble',
      optionSet: { menu: round.menu },
      chosen: { option: 'A' },
    });
  }
  const rng = new Rng(tx.state.rng); // mutates tx.state.rng in place
  for (const seat of active) {
    const option = round.gambles[seat]!.value;
    const spec = GAMBLE_MENUS[round.menu][option];
    let immediate = 0;
    switch (spec.kind) {
      case 'sure':
      case 'now':
        immediate = spec.amount;
        break;
      case 'chance':
        if (rng.chancePercent(spec.percent)) immediate = spec.amount;
        break;
      case 'at_end':
      case 'at_end_if_not_exiled': {
        const onlyIfNotExiled = spec.kind === 'at_end_if_not_exiled';
        tx.state.delays.push({
          seat,
          round: round.round,
          option,
          amount: spec.amount,
          onlyIfNotExiled,
          status: 'pending',
        });
        tx.emit('delay_scheduled', seat, {
          round: round.round,
          option,
          amount: spec.amount,
          onlyIfNotExiled,
        });
        break;
      }
    }
    round.gambleOutcomes[seat] = { option, immediate };
    if (immediate > 0) {
      tx.seat(seat).balance += immediate;
      tx.emit('gamble_won', seat, { round: round.round, menu: round.menu, option, created: immediate });
    } else if (spec.kind === 'chance') {
      tx.emit('gamble_lost', seat, { round: round.round, menu: round.menu, option });
    }
  }
}

/** SPEC §Vote: exiled iff ≥ 3 votes and strictly more than anyone else. Timeouts skip. */
function resolveVote(prev: MatchState, tx: Tx): void {
  const round = currentRound(tx.state);
  const active = activeSeats(tx.state);
  for (const seat of active) {
    if (round.votes[seat] !== null) continue;
    round.votes[seat] = { value: null, timedOut: true };
    emitDecision(tx, seat, {
      ...timeoutBase(prev, seat),
      kind: 'vote',
      optionSet: { targets: otherActive(prev, seat) },
      chosen: { target: null },
    });
  }
  const tally = Array.from({ length: SEAT_COUNT }, () => 0);
  for (const seat of active) {
    const target = round.votes[seat]!.value;
    if (target !== null) tally[target]!++;
  }
  const exiled = exileOutcome(tally);
  round.voteResult = { tally, exiled };
  tx.emit('vote_resolved', null, { round: round.round, tally, exiled });
  if (exiled === null) return;
  tx.seat(exiled).exiledRound = round.round;
  tx.emit('seat_exiled', exiled, { round: round.round, votes: tally[exiled]! });
  // SPEC §Vote: forfeits pending "+12 if not exiled" payouts; keeps "+8 at match end".
  for (const d of tx.state.delays) {
    if (d.seat === exiled && d.onlyIfNotExiled && d.status === 'pending') {
      d.status = 'forfeited';
      tx.emit('delay_forfeited', exiled, { round: d.round, amount: d.amount, exiledRound: round.round });
    }
  }
}

/** SPEC §Vote exile threshold. Exported for tests. */
export function exileOutcome(tally: readonly number[]): SeatId | null {
  let max = 0;
  let leader: SeatId | null = null;
  let tied = false;
  tally.forEach((v, seat) => {
    if (v > max) {
      max = v;
      leader = seat;
      tied = false;
    } else if (v === max && v > 0) {
      tied = true;
    }
  });
  return max >= EXILE_MIN_VOTES && !tied ? leader : null;
}

/** SPEC §Final ballot, §Scoring (humans), §Reveal. */
function resolveFinalBallot(prev: MatchState, tx: Tx): void {
  const s = tx.state;
  const allSeats = s.seats.map((x) => x.seatId);
  for (const seat of allSeats) {
    if (s.ballots[seat] !== null) continue;
    s.ballots[seat] = { labels: [], timedOut: true };
    emitDecision(tx, seat, {
      ...timeoutBase(prev, seat),
      kind: 'ballot',
      optionSet: { targets: allSeats.filter((t) => t !== seat) },
      chosen: { labels: [] },
    });
  }

  tx.emit('phase_ended', null, { round: s.round, phase: 'final_ballot' });

  const results = s.seats.map((x) => ({
    coinsBeforeReveal: x.balance,
    delayPaid: 0,
    exileBonus: 0,
    ballotPayoff: 0,
    finalScore: 0,
  }));

  // Delayed gamble payouts are created at match end.
  for (const d of s.delays) {
    if (d.status !== 'pending') continue;
    if (d.onlyIfNotExiled && s.seats[d.seat]!.exiledRound !== null) {
      throw new InvariantViolationError('delay', `pending conditional delay for exiled seat ${d.seat}`);
    }
    d.status = 'paid';
    tx.seat(d.seat).balance += d.amount;
    results[d.seat]!.delayPaid += d.amount;
    tx.emit('delay_paid', d.seat, { round: d.round, created: d.amount });
  }

  // Exile bonuses: human voters whose vote was for the seat actually exiled that round (DECISIONS "Exile bonus").
  for (const r of s.rounds) {
    const target = r.voteResult?.exiled;
    if (target === null || target === undefined) continue;
    const targetIsAgent = s.seats[target]!.isAgent;
    r.votes.forEach((v, voter) => {
      if (!v || v.value !== target || s.seats[voter]!.isAgent) return;
      const delta = targetIsAgent ? EXILE_BONUS_AGENT : EXILE_BONUS_HUMAN;
      tx.seat(voter).balance += delta;
      results[voter]!.exileBonus += delta;
      tx.emit('exile_bonus', voter, { round: r.round, target, targetIsAgent, delta });
    });
  }

  // Ballot payoffs: computed for every label, applied only to human voters (SPEC §Final ballot).
  for (const voter of s.seats) {
    for (const l of s.ballots[voter.seatId]!.labels) {
      const targetIsAgent = s.seats[l.target]!.isAgent;
      const payoff = ballotPayoff(l.label, l.confidence, targetIsAgent);
      const applied = !voter.isAgent;
      if (applied) {
        voter.balance += payoff;
        results[voter.seatId]!.ballotPayoff += payoff;
      }
      tx.emit('ballot_scored', voter.seatId, {
        target: l.target,
        label: l.label,
        confidence: l.confidence,
        targetIsAgent,
        payoff,
        applied,
      });
    }
  }

  for (const x of s.seats) results[x.seatId]!.finalScore = x.balance;
  s.reveal = results;
  tx.emit('match_ended', null, {
    finalScores: s.seats.map((x) => x.balance),
    seats: s.seats.map((x) => ({ seatId: x.seatId, isAgent: x.isAgent, agentVersion: x.agentVersion })),
  });
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

export type MatchInput = { kind: 'action'; action: Action; now: number } | { kind: 'advance'; now: number };

/**
 * Rebuilds a match from its config, seed and ordered inputs (CLAUDE.md invariant 1). Rejected actions
 * are skipped exactly as the server skipped them, so a recorded input log always replays.
 */
export function replay(config: MatchConfig, seed: string, inputs: readonly MatchInput[]): Transition {
  let { state } = createMatch(config, seed);
  const events: MatchEvent[] = [];
  for (const input of inputs) {
    try {
      const t =
        input.kind === 'advance'
          ? advancePhase(state, input.now)
          : applyAction(state, input.action, input.now);
      state = t.state;
      events.push(...t.events);
    } catch (e) {
      if (!(e instanceof ActionRejectedError)) throw e;
    }
  }
  return { state, events };
}
