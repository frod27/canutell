import { describe, expect, it } from 'vitest';
import { checkInvariants, coinDelta, coinsInPlay, InvariantViolationError, Rng } from '../src';
import { Driver, makeConfig, playMatchRandomly } from './helpers';

// SPEC §Coin math; CLAUDE.md invariant 3.

describe('coin conservation — SPEC §Coin math', () => {
  it('the event log explains every coin: 600 + Σ created − Σ destroyed = Σ final scores', () => {
    for (let i = 0; i < 30; i++) {
      const d = new Driver(
        makeConfig({ mode: i % 2 ? 'quick' : 'full', agents: i % 3 === 0 ? [] : [i % 6] }),
        `cons-${i}`,
      );
      playMatchRandomly(d, Rng.fromSeed(`cons-in-${i}`), { skipPct: 10 });
      const delta = d.events.reduce((sum, e) => sum + coinDelta(e), 0);
      const finals = d.state.reveal!.reduce((sum, r) => sum + r.finalScore, 0);
      expect(finals).toBe(600 + delta);
      expect(coinsInPlay(d.state)).toBe(
        d.state.ledger.initial + d.state.ledger.created - d.state.ledger.destroyed,
      );
      for (const s of d.state.seats) expect(Number.isInteger(s.balance)).toBe(true);
    }
  });

  it('only the named events create or destroy coins', () => {
    const d = new Driver();
    playMatchRandomly(d, Rng.fromSeed('named'));
    const minting = new Set(d.events.filter((e) => coinDelta(e) !== 0).map((e) => e.type));
    for (const t of minting) {
      expect([
        'pot_multiplied',
        'pot_remainder_burned',
        'stake_multiplied',
        'gamble_won',
        'delay_paid',
        'exile_bonus',
        'ballot_scored',
      ]).toContain(t);
    }
  });

  it('checkInvariants catches unlogged coin creation', () => {
    const d = new Driver();
    const tampered = structuredClone(d.state);
    tampered.seats[0]!.balance += 1;
    expect(() => checkInvariants(d.state, tampered, [])).toThrow(InvariantViolationError);
  });

  it('checkInvariants catches negative and fractional balances before Reveal', () => {
    const d = new Driver();
    const neg = structuredClone(d.state);
    neg.seats[0]!.balance = -1;
    neg.seats[1]!.balance += 101;
    neg.ledger.created += 0;
    expect(() => checkInvariants(d.state, neg, [])).toThrow(/non_negative|conservation/);
    const frac = structuredClone(d.state);
    frac.seats[0]!.balance -= 0.5;
    frac.seats[1]!.balance += 0.5;
    expect(() => checkInvariants(d.state, frac, [])).toThrow(/integer_coins/);
  });

  it('checkInvariants catches a gap in event sequence numbers', () => {
    const d = new Driver();
    const next = structuredClone(d.state);
    next.seq += 1;
    expect(() => checkInvariants(d.state, next, [])).toThrow(/event_seq/);
  });
});
