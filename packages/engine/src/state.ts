import type {
  BallotLabel,
  ChatChannel,
  GambleMenuKind,
  GambleOption,
  Mode,
  Phase,
  RevealMode,
  SeatId,
  TimedPhase,
} from '@canutell/protocol';
import type { RngState } from './rng';

// Full server-side match state. It is plain JSON (arrays indexed by seatId, null for "nothing yet",
// no Maps or undefined) so it clones, serializes and hashes deterministically.
// It contains roles: it must never be sent to a client. Clients get viewFor(state, seat).

export interface SeatState {
  seatId: SeatId;
  isAgent: boolean;
  agentVersion: string | null;
  /** Integer coins. Never negative before Reveal. */
  balance: number;
  exiledRound: number | null;
}

export interface Choice<T> {
  value: T;
  timedOut: boolean;
}

export interface InvestResult {
  pot: number;
  activeCount: number;
  share: number;
  multiplied: number;
  burned: number;
}

export interface GambleOutcome {
  option: GambleOption;
  /** Coins credited now (0 for a loss or a delayed option). */
  immediate: number;
}

export interface RoundState {
  round: number;
  menu: GambleMenuKind;
  contributions: (Choice<number> | null)[];
  investResult: InvestResult | null;
  stakes: (Choice<{ to: SeatId | null; amount: number }> | null)[];
  gambles: (Choice<GambleOption> | null)[];
  gambleOutcomes: (GambleOutcome | null)[];
  votes: (Choice<SeatId | null> | null)[];
  voteResult: { tally: number[]; exiled: SeatId | null } | null;
}

export interface StakeState {
  stakeId: string;
  round: number;
  from: SeatId;
  to: SeatId;
  sent: number;
  received: number;
  /** null while open. */
  returned: number | null;
  returnTimedOut: boolean | null;
  /** The stake closes at the end of this round's Deal (SPEC §Deal). */
  returnDeadlineRound: number;
}

export interface DelayState {
  seat: SeatId;
  round: number;
  option: GambleOption;
  amount: number;
  onlyIfNotExiled: boolean;
  status: 'pending' | 'paid' | 'forfeited';
}

export interface ChatState {
  index: number;
  round: number;
  phase: TimedPhase;
  from: SeatId;
  channel: ChatChannel;
  to: SeatId | null;
  text: string;
  at: number;
}

export interface BallotState {
  labels: BallotLabel[];
  timedOut: boolean;
}

export interface RevealSeatResult {
  coinsBeforeReveal: number;
  delayPaid: number;
  exileBonus: number;
  ballotPayoff: number;
  finalScore: number;
}

export interface MatchState {
  rulesetVersion: string;
  matchId: string;
  seed: string;
  mode: Mode;
  isParty: boolean;
  revealMode: RevealMode;
  totalRounds: number;

  seats: SeatState[];
  round: number;
  phase: Phase;
  phaseStartedAt: number | null;
  deadline: number | null;
  /** Latest server time seen. Inputs must not go backwards. */
  clock: number | null;

  /** Next event sequence number. */
  seq: number;
  rng: RngState;

  /** Coins escrowed in the current round's pot. */
  pot: number;
  ledger: { initial: number; created: number; destroyed: number };

  rounds: RoundState[];
  stakes: StakeState[];
  delays: DelayState[];
  chat: ChatState[];
  ballots: (BallotState | null)[];
  reveal: RevealSeatResult[] | null;
}

export function activeSeats(state: MatchState): SeatId[] {
  return state.seats.filter((s) => s.exiledRound === null).map((s) => s.seatId);
}

export function isActive(state: MatchState, seat: SeatId): boolean {
  return state.seats[seat]?.exiledRound === null;
}

export function currentRound(state: MatchState): RoundState {
  const r = state.rounds[state.round - 1];
  if (!r) throw new Error(`no round state for round ${state.round}`);
  return r;
}

/** Coins that exist in the match right now: balances plus the escrowed pot. */
export function coinsInPlay(state: MatchState): number {
  let total = state.pot;
  for (const s of state.seats) total += s.balance;
  return total;
}

/**
 * Copy for a transition. Every container the engine mutates is copied: seats, stakes and delays
 * (fields change), round records and their per-seat arrays (slots are reassigned), the append-only
 * lists, the ledger and the RNG words. Leaf records that are only ever replaced, never edited
 * (choices, chat messages, ballots, results), are shared. This is ~10× faster than structuredClone;
 * the "never mutates input state" tests guard the rule.
 */
export function cloneState(state: MatchState): MatchState {
  return {
    ...state,
    seats: state.seats.map((s) => ({ ...s })),
    rng: [...state.rng] as RngState,
    ledger: { ...state.ledger },
    rounds: state.rounds.map((r) => ({
      ...r,
      contributions: r.contributions.slice(),
      stakes: r.stakes.slice(),
      gambles: r.gambles.slice(),
      gambleOutcomes: r.gambleOutcomes.slice(),
      votes: r.votes.slice(),
    })),
    stakes: state.stakes.map((s) => ({ ...s })),
    delays: state.delays.map((d) => ({ ...d })),
    chat: state.chat.slice(),
    ballots: state.ballots.slice(),
  };
}
