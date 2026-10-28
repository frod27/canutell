import { describe, expect, it } from 'vitest';
import { Driver, makeConfig, seedWithRevealMode } from './helpers';

describe('invest — SPEC §Invest', () => {
  it('accepts 0–20, deducts immediately into the pot, one choice per round', () => {
    const d = new Driver();
    d.act({ type: 'invest', seat: 0, amount: 20 });
    expect(d.balance(0)).toBe(80);
    expect(d.state.pot).toBe(20);
    d.reject({ type: 'invest', seat: 0, amount: 1 }, 'already_acted');
    d.reject({ type: 'invest', seat: 1, amount: 21 } as never, 'invalid_action');
    d.reject({ type: 'invest', seat: 1, amount: -1 } as never, 'invalid_action');
    d.reject({ type: 'invest', seat: 1, amount: 2.5 } as never, 'invalid_action');
  });

  it('caps the contribution at the balance', () => {
    const d = new Driver();
    d.state.seats[3]!.balance = 7; // test fixture: low balance (pot/ledger untouched → adjust ledger)
    d.state.ledger.destroyed += 93;
    d.reject({ type: 'invest', seat: 3, amount: 8 }, 'insufficient_balance');
    d.act({ type: 'invest', seat: 3, amount: 7 });
    expect(d.balance(3)).toBe(0);
    expect(d.decisions('invest').at(-1)!.payload.optionSet).toEqual({ min: 0, max: 7 });
  });

  it('is only allowed in the Invest phase', () => {
    const d = new Driver();
    d.endPhase();
    d.reject({ type: 'invest', seat: 0, amount: 5 }, 'wrong_phase');
  });

  it('individual reveal mode shows every contribution after Invest, and nothing before', () => {
    const d = new Driver(makeConfig(), seedWithRevealMode('individual'));
    d.act({ type: 'invest', seat: 0, amount: 20 });
    d.act({ type: 'invest', seat: 1, amount: 0 });
    // Before resolution, seat 2 sees nothing about seat 0's contribution.
    expect(d.view(2).investResults).toEqual([]);
    expect(JSON.stringify(d.view(2))).not.toContain('"amount":20');
    d.endPhase();
    const result = d.view(2).investResults[0]!;
    expect(result.pot).toBe(20);
    expect(result.share).toBe(5);
    expect(result.contributions).toEqual([
      { seat: 0, amount: 20 },
      { seat: 1, amount: 0 },
      { seat: 2, amount: 0 },
      { seat: 3, amount: 0 },
      { seat: 4, amount: 0 },
      { seat: 5, amount: 0 },
    ]);
  });

  it('aggregate reveal mode shows only the pot total', () => {
    const d = new Driver(makeConfig(), seedWithRevealMode('aggregate'));
    d.act({ type: 'invest', seat: 0, amount: 20 });
    d.endPhase();
    const result = d.view(3).investResults[0]!;
    expect(result.pot).toBe(20);
    expect(result.contributions).toBeNull();
    const logged = d.eventsOf('invest_revealed')[0]!;
    expect(logged.payload.contributions).toBeNull();
    // Own contribution history remains visible to the contributor only.
    expect(d.view(0).myContributions).toEqual([{ round: 1, amount: 20 }]);
    expect(d.view(3).myContributions).toEqual([{ round: 1, amount: 0 }]);
  });

  it('logs pot_multiplied and pot_remainder_burned for the coins created and destroyed', () => {
    const d = new Driver();
    d.act({ type: 'invest', seat: 0, amount: 10 }); // P = 10, n = 6: G = 16, share 2, burn 4
    d.endPhase();
    expect(d.eventsOf('pot_multiplied')[0]!.payload).toEqual({ round: 1, pot: 10, created: 6 });
    expect(d.eventsOf('pot_remainder_burned')[0]!.payload).toEqual({ round: 1, destroyed: 4 });
    expect(d.balance(0)).toBe(92);
    expect(d.balance(1)).toBe(102);
  });
});
