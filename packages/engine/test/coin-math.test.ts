import { describe, expect, it } from 'vitest';
import { ballotPayoff, roundHalfAwayFromZero, splitPot } from '../src';
import { ALL, Driver, makeConfig } from './helpers';

describe('pot payout — SPEC §Coin math', () => {
  // SPEC §Coin math: each active player receives floor(P*16/(10n)); the remainder is burned.
  it('matches the SPEC formula and conserves coins for every n from 1 to 6 and every reachable pot', () => {
    for (let n = 1; n <= 6; n++) {
      for (let P = 0; P <= 20 * 6; P++) {
        const s = splitPot(P, n);
        expect(s.share).toBe(Math.floor((P * 16) / (10 * n)));
        expect(s.multiplied).toBe(Math.floor((6 * P) / 10));
        expect(P + s.multiplied - s.burned).toBe(n * s.share);
        expect(s.burned).toBeGreaterThanOrEqual(0);
        expect(s.burned).toBeLessThan(n);
        for (const v of [s.share, s.multiplied, s.burned]) expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it.each([
    // [P, n, share, multiplied, burned]
    [0, 6, 0, 0, 0],
    [1, 1, 1, 0, 0],
    [1, 2, 0, 0, 1],
    [3, 5, 0, 1, 4],
    [5, 4, 2, 3, 0],
    [7, 3, 3, 4, 2],
    [10, 6, 2, 6, 4],
    [13, 6, 3, 7, 2],
    [100, 5, 32, 60, 0],
    [120, 6, 32, 72, 0],
    [119, 6, 31, 71, 4],
  ])('P=%i n=%i → share %i, multiplied %i, burned %i', (P, n, share, multiplied, burned) => {
    expect(splitPot(P, n)).toEqual({ pot: P, activeCount: n, share, multiplied, burned });
  });

  it('rejects non-integer or empty inputs', () => {
    expect(() => splitPot(1.5, 3)).toThrow();
    expect(() => splitPot(-1, 3)).toThrow();
    expect(() => splitPot(10, 0)).toThrow();
  });

  // SPEC §Coin math + §Invest, end to end: n shrinks 6 → 5 → 4 → 3 as players are exiled.
  it('pays and burns correctly in a live match as the active count falls from 6 to 3', () => {
    const d = new Driver(makeConfig({ mode: 'full' }));
    const expectRound = (round: number, active: number[], amounts: number[]) => {
      d.goTo('invest', round);
      const before = active.map((s) => d.balance(s as 0));
      active.forEach((s, i) => d.act({ type: 'invest', seat: s as 0, amount: amounts[i]! }));
      d.endPhase();
      const P = amounts.reduce((a, b) => a + b, 0);
      const n = active.length;
      const share = Math.floor((P * 16) / (10 * n));
      active.forEach((s, i) => expect(d.balance(s as 0)).toBe(before[i]! - amounts[i]! + share));
      const burn = d.eventsOf('pot_remainder_burned').at(-1)!;
      const mult = d.eventsOf('pot_multiplied').at(-1)!;
      expect(mult.payload.created).toBe(Math.floor((16 * P) / 10) - P);
      expect(burn.payload.destroyed).toBe(Math.floor((16 * P) / 10) - n * share);
      expect(d.eventsOf('pot_paid').at(-1)!.payload).toMatchObject({ activeCount: n, share });
    };
    expectRound(1, ALL, [1, 2, 3, 4, 5, 6]); // P=21, n=6: share 5, burn 3
    d.goTo('vote', 2);
    d.exile(5, [0, 1, 2]);
    expectRound(3, [0, 1, 2, 3, 4], [7, 0, 0, 0, 0]); // P=7, n=5: share 2, burn 1
    d.goTo('vote', 3);
    d.exile(4, [0, 1, 2]);
    expectRound(4, [0, 1, 2, 3], [3, 3, 3, 4]); // P=13, n=4: share 5, burn 0
    d.goTo('vote', 4);
    d.exile(3, [0, 1, 2]);
    expectRound(5, [0, 1, 2], [1, 1, 0]); // P=2, n=3: share 1, burn 0
  });
});

describe('ballot payoff — SPEC §Scoring (humans)', () => {
  it('+30 for a certain correct label', () => {
    expect(ballotPayoff('agent', 100, true)).toBe(30);
    expect(ballotPayoff('human', 100, false)).toBe(30);
  });

  it('−10 for a certain wrong label', () => {
    expect(ballotPayoff('agent', 100, false)).toBe(-10);
    expect(ballotPayoff('human', 100, true)).toBe(-10);
  });

  // DECISIONS 2026-10-28 "Ballot payoff at 50/50": the formula gives +20 at q = 0.5, not 0.
  it('+20 at confidence 50 for either label and either role (formula kept as written)', () => {
    for (const label of ['agent', 'human'] as const) {
      for (const isAgent of [true, false]) expect(ballotPayoff(label, 50, isAgent)).toBe(20);
    }
  });

  it('rounds half away from zero: 27.5 → 28 and 7.5 → 8', () => {
    expect(ballotPayoff('agent', 75, true)).toBe(28); // 40(0.75 − 0.0625) = 27.5
    expect(ballotPayoff('agent', 75, false)).toBe(8); // 40(0.75 − 0.5625) = 7.5
    expect(ballotPayoff('human', 75, false)).toBe(28);
    expect(ballotPayoff('human', 75, true)).toBe(8);
  });

  it('rounds non-half values to nearest, including negatives', () => {
    expect(ballotPayoff('agent', 60, true)).toBe(24); // 23.6
    expect(ballotPayoff('agent', 90, false)).toBe(-2); // −2.4
    expect(ballotPayoff('agent', 95, false)).toBe(-6); // −6.1
  });

  it('matches the real-valued formula at every confidence, rounded half away from zero', () => {
    for (let c = 50; c <= 100; c++) {
      for (const label of ['agent', 'human'] as const) {
        for (const isAgent of [true, false]) {
          const q = label === 'agent' ? c / 100 : 1 - c / 100;
          const y = isAgent ? 1 : 0;
          const exact = 40 * (0.75 - (q - y) ** 2);
          const expected = Math.sign(exact) * Math.round(Math.abs(exact) + 1e-9);
          expect(ballotPayoff(label, c, isAgent)).toBe(expected === 0 ? 0 : expected);
        }
      }
    }
  });

  it('the unrounded rule is strictly proper: expected payoff peaks exactly at the honest report', () => {
    const exact = (q: number, y: number) => 40 * (0.75 - (q - y) ** 2);
    for (let p = 0; p <= 100; p++) {
      let bestQ = -1;
      let best = -Infinity;
      for (let q = 0; q <= 100; q++) {
        const ev = (p / 100) * exact(q / 100, 1) + (1 - p / 100) * exact(q / 100, 0);
        if (ev > best + 1e-12) {
          best = ev;
          bestQ = q;
        }
      }
      expect(bestQ).toBe(p);
    }
  });

  // Rounding moves each outcome by at most ½, so (best rounded EV) − (honest rounded EV)
  // ≤ (honest exact EV + ½) − (honest exact EV − ½) = 1 coin per label.
  it('after rounding, the honest report is within 1 coin of the best expected payoff', () => {
    for (let p = 0; p <= 100; p++) {
      const ev = (label: 'agent' | 'human', c: number) =>
        (p * ballotPayoff(label, c, true) + (100 - p) * ballotPayoff(label, c, false)) / 100;
      let best = -Infinity;
      for (let c = 50; c <= 100; c++) best = Math.max(best, ev('agent', c), ev('human', c));
      const honest = p >= 50 ? ev('agent', p) : ev('human', 100 - p);
      expect(best - honest).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('rejects confidence outside 50–100', () => {
    expect(() => ballotPayoff('agent', 49, true)).toThrow();
    expect(() => ballotPayoff('agent', 101, true)).toThrow();
    expect(() => ballotPayoff('agent', 75.5, true)).toThrow();
  });

  it('roundHalfAwayFromZero', () => {
    expect(roundHalfAwayFromZero(5, 2)).toBe(3);
    expect(roundHalfAwayFromZero(-5, 2)).toBe(-3);
    expect(roundHalfAwayFromZero(-7, 2)).toBe(-4);
    expect(roundHalfAwayFromZero(-1, 3)).toBe(0);
    expect(roundHalfAwayFromZero(4, 2)).toBe(2);
  });
});
