import { MAX_AGENTS, SEAT_COUNT } from '@canutell/protocol';
import { Rng } from './rng';

/**
 * SPEC §Match structure: each match seats 0, 1 or 2 agents (MVP: equal odds, configurable).
 * Matchmaking (server) or the simulator calls this to decide which seats are agents before createMatch.
 * `weights[k]` is the relative weight of seating exactly k agents.
 */
export function drawAgentSeats(seed: string, weights: readonly number[] = [1, 1, 1]): boolean[] {
  if (weights.length !== MAX_AGENTS + 1 || weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new RangeError(`weights must be ${MAX_AGENTS + 1} non-negative integers`);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new RangeError('weights sum to zero');
  const rng = Rng.fromSeed(`${seed}:agents`);
  let roll = rng.nextInt(total);
  let count = 0;
  while (roll >= weights[count]!) roll -= weights[count++]!;
  const seats = Array.from({ length: SEAT_COUNT }, (_, i) => i);
  for (let i = SEAT_COUNT - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [seats[i], seats[j]] = [seats[j]!, seats[i]!];
  }
  const agents = new Set(seats.slice(0, count));
  return Array.from({ length: SEAT_COUNT }, (_, i) => agents.has(i));
}
