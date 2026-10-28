import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  POT_MULT_DEN,
  POT_MULT_NUM,
  type BallotLabelValue,
} from '@canutell/protocol';

// SPEC §Coin math. All integer arithmetic. No floats reach a balance.

export interface PotSplit {
  pot: number;
  activeCount: number;
  /** floor(P * 16 / (10 * n)) — SPEC §Coin math, literally. */
  share: number;
  /** floor(16P/10) - P, logged as `pot_multiplied`. */
  multiplied: number;
  /** floor(16P/10) - n * share, logged as `pot_remainder_burned`. */
  burned: number;
}

/**
 * SPEC §Coin math "Pot payout". The payout per player is exactly the SPEC formula. The accounting
 * (DECISIONS "Pot accounting") splits the integer grown pot G = floor(16P/10) into P + multiplied, then
 * burns G - n*share. Because floor(floor(x)/n) = floor(x/n), share = floor(G/n), so 0 <= burned < n.
 */
export function splitPot(pot: number, activeCount: number): PotSplit {
  if (!Number.isInteger(pot) || pot < 0)
    throw new RangeError(`pot must be a non-negative integer, got ${pot}`);
  if (!Number.isInteger(activeCount) || activeCount < 1)
    throw new RangeError(`activeCount must be a positive integer, got ${activeCount}`);
  const share = Math.floor((pot * POT_MULT_NUM) / (POT_MULT_DEN * activeCount));
  const grown = Math.floor((pot * POT_MULT_NUM) / POT_MULT_DEN);
  const multiplied = grown - pot;
  const burned = grown - activeCount * share;
  return { pot, activeCount, share, multiplied, burned };
}

/** Round half away from zero for the rational num/den (den > 0), in integers. */
export function roundHalfAwayFromZero(num: number, den: number): number {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0)
    throw new RangeError('integer num, den > 0');
  const sign = num < 0 ? -1 : 1;
  const a = Math.abs(num);
  // round(a/den) half-up = floor((2a + den) / (2 den))
  const r = Math.floor((2 * a + den) / (2 * den));
  return r === 0 ? 0 : sign * r;
}

/**
 * SPEC §Scoring "Ballot payoff": B = 40 × (0.75 − (q − y)²), rounded half away from zero.
 * q = confidence/100 for an `agent` label, 1 − confidence/100 for `human`; y = 1 if target is an agent.
 *
 * In integers, with d = 100q − 100y ∈ [−100, 100]:
 *   B = 40 × (0.75 − d²/10000) = (7500 − d²) / 250.
 * Values: +30 certain & right, −10 certain & wrong, +20 at confidence 50 (DECISIONS "Ballot payoff at 50/50").
 */
export function ballotPayoff(label: BallotLabelValue, confidence: number, targetIsAgent: boolean): number {
  if (!Number.isInteger(confidence) || confidence < CONFIDENCE_MIN || confidence > CONFIDENCE_MAX)
    throw new RangeError(`confidence must be an integer in [${CONFIDENCE_MIN}, ${CONFIDENCE_MAX}]`);
  const q100 = label === 'agent' ? confidence : 100 - confidence;
  const d = q100 - (targetIsAgent ? 100 : 0);
  return roundHalfAwayFromZero(7500 - d * d, 250);
}
