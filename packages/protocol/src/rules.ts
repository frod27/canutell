// Rule constants from docs/SPEC.md v0.2. The engine reads every number from here; schemas use them as bounds.

export const RULESET_VERSION = 'v0.2';

/** SPEC §Match structure */
export const SEAT_COUNT = 6;
export const SEAT_IDS = [0, 1, 2, 3, 4, 5] as const;
export const ROUNDS_BY_MODE = { full: 5, quick: 3 } as const;
export const MAX_AGENTS = 2;

/** SPEC §Match structure, phase durations table. */
export const PHASE_DURATION_MS = {
  invest: 30_000,
  deal: 60_000,
  gamble: 15_000,
  vote: 30_000,
  final_ballot: 45_000,
} as const;

/** SPEC §Vote: voting runs from this round onward. */
export const FIRST_VOTE_ROUND = 2;

/** SPEC §Coins */
export const STARTING_COINS = 100;

/** SPEC §Invest */
export const INVEST_MAX = 20;
/** SPEC §Coin math: pot multiplier 16/10. */
export const POT_MULT_NUM = 16;
export const POT_MULT_DEN = 10;

/** SPEC §Deal */
export const STAKE_MIN = 1;
export const STAKE_MAX = 20;
/** Stake doubles on arrival: received = sent × 2. Return range is 0..received. */
export const STAKE_MULTIPLIER = 2;

/** SPEC §Vote */
export const EXILE_MIN_VOTES = 3;

/** SPEC §Final ballot */
export const CONFIDENCE_MIN = 50;
export const CONFIDENCE_MAX = 100;

/** SPEC §Scoring (humans) */
export const EXILE_BONUS_AGENT = 10;
export const EXILE_BONUS_HUMAN = -5;

/** DECISIONS 2026-10-28 "Chat limits". */
export const CHAT_MAX_LENGTH = 500;

export type GambleMenuKind = 'risk' | 'delay';
export type GambleOption = 'A' | 'B' | 'C';

export type GambleOptionSpec =
  | { kind: 'sure'; amount: number }
  | { kind: 'chance'; amount: number; percent: number }
  | { kind: 'now'; amount: number }
  | { kind: 'at_end'; amount: number }
  | { kind: 'at_end_if_not_exiled'; amount: number };

/** SPEC §Gamble menus (MVP fixed menus). */
export const GAMBLE_MENUS: Record<GambleMenuKind, Record<GambleOption, GambleOptionSpec>> = {
  risk: {
    A: { kind: 'sure', amount: 5 },
    B: { kind: 'chance', amount: 12, percent: 50 },
    C: { kind: 'chance', amount: 30, percent: 20 },
  },
  delay: {
    A: { kind: 'now', amount: 5 },
    B: { kind: 'at_end', amount: 8 },
    C: { kind: 'at_end_if_not_exiled', amount: 12 },
  },
};

/**
 * SPEC §Gamble: full mode risk rounds 1,3,5 and delay rounds 2,4; quick mode risk 1,3 and delay 2.
 * Both modes reduce to "odd rounds are risk, even rounds are delay".
 */
export function gambleMenuFor(round: number): GambleMenuKind {
  return round % 2 === 0 ? 'delay' : 'risk';
}
