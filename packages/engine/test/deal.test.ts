import { describe, expect, it } from 'vitest';
import { Driver, makeConfig } from './helpers';

describe('stakes — SPEC §Deal', () => {
  it('doubles on arrival and logs stake_multiplied for the created coins', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 15 });
    expect(d.balance(0)).toBe(85);
    expect(d.balance(1)).toBe(130);
    expect(d.eventsOf('stake_sent')[0]!.payload).toEqual({
      stakeId: 'r1s0',
      round: 1,
      from: 0,
      to: 1,
      amount: 15,
      returnDeadlineRound: 2,
    });
    expect(d.eventsOf('stake_multiplied')[0]!.payload).toEqual({ stakeId: 'r1s0', created: 15 });
  });

  it('allows at most one stake per round, 1–20, to one other active player', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.reject({ type: 'stake', seat: 0, to: 0, amount: 5 }, 'invalid_target');
    d.reject({ type: 'stake', seat: 0, to: 1, amount: 21 } as never, 'invalid_action');
    d.reject({ type: 'stake', seat: 0, to: 1, amount: 0 }, 'invalid_action');
    d.reject({ type: 'stake', seat: 0, to: null, amount: 3 }, 'invalid_action');
    d.act({ type: 'stake', seat: 0, to: 1, amount: 1 });
    d.reject({ type: 'stake', seat: 0, to: 2, amount: 1 }, 'already_acted');
    d.act({ type: 'stake', seat: 1, to: 0, amount: 20 });
  });

  it('a deliberate pass is a decision with timedOut = false, distinct from a timeout', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: null, amount: 0 });
    d.reject({ type: 'stake', seat: 0, to: 1, amount: 5 }, 'already_acted');
    d.endPhase();
    const stakes = d.decisions('stake');
    expect(stakes).toHaveLength(6);
    expect(stakes.find((e) => e.seat === 0)!.payload).toMatchObject({
      chosen: { to: null, amount: 0 },
      timedOut: false,
    });
    for (const e of stakes.filter((e) => e.seat !== 0)) {
      expect(e.payload).toMatchObject({ chosen: { to: null, amount: 0 }, timedOut: true });
    }
  });

  it('cannot stake to an exiled player; an exiled player cannot stake', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.exile(5, [0, 1, 2]);
    d.goTo('deal', 3);
    d.reject({ type: 'stake', seat: 0, to: 5, amount: 5 }, 'invalid_target');
    d.reject({ type: 'stake', seat: 5, to: 0, amount: 5 }, 'not_active');
  });

  it('caps the stake at the balance', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.state.seats[2]!.balance = 4;
    d.state.ledger.destroyed += 96;
    d.reject({ type: 'stake', seat: 2, to: 1, amount: 5 }, 'insufficient_balance');
    d.act({ type: 'stake', seat: 2, to: 1, amount: 4 });
  });
});

describe('returns — SPEC §Deal', () => {
  it('returns 0..2s once, moving coins from receiver to sender', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 10 });
    d.reject({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 21 }, 'out_of_range');
    d.reject({ type: 'return', seat: 2, stakeId: 'r1s0', amount: 1 }, 'not_receiver');
    d.reject({ type: 'return', seat: 1, stakeId: 'nope', amount: 1 }, 'unknown_stake');
    d.act({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 20 });
    expect(d.balance(0)).toBe(110);
    expect(d.balance(1)).toBe(100);
    d.reject({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 0 }, 'stake_closed');
    expect(d.eventsOf('stake_returned')[0]!.payload).toEqual({
      stakeId: 'r1s0',
      from: 0,
      to: 1,
      amount: 20,
      timedOut: false,
    });
  });

  it('a deliberate return of 0 is not a timeout', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 10 });
    d.act({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 0 });
    expect(d.decisions('return')[0]!.payload).toMatchObject({ timedOut: false, chosen: { amount: 0 } });
  });

  it('stays open across the round boundary until the end of the next Deal, in any phase', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 5 });
    d.goTo('gamble', 1);
    expect(d.view(1).prompts.some((p) => p.kind === 'return')).toBe(true);
    d.goTo('invest', 2);
    d.goTo('deal', 2);
    d.act({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 7 });
    expect(d.decisions('return')[0]!.payload).toMatchObject({ round: 2, phase: 'deal', timedOut: false });
  });

  it('is accepted in a non-Deal phase of the next round (e.g. round 2 Invest)', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 5 });
    d.goTo('invest', 2);
    d.act({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 3 });
    expect(d.decisions('return')[0]!.payload).toMatchObject({ round: 2, phase: 'invest' });
  });

  it('closes at the end of the next Deal with return 0 logged as timedOut', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 5 });
    d.goTo('deal', 2);
    expect(d.state.stakes[0]!.returned).toBeNull();
    d.endPhase(); // end of round 2 Deal
    expect(d.state.stakes[0]).toMatchObject({ returned: 0, returnTimedOut: true });
    const ret = d.decisions('return')[0]!;
    expect(ret.seat).toBe(1);
    expect(ret.payload).toMatchObject({ round: 2, phase: 'deal', timedOut: true, chosen: { amount: 0 } });
    expect(ret.payload.decidedAt).toBe(ret.payload.phaseStartedAt + 60_000);
    d.reject({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 1 }, 'stake_closed');
  });

  it('in the last round, closes at the end of that round’s Deal', () => {
    const d = new Driver(makeConfig({ mode: 'quick' }));
    d.goTo('deal', 3);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 5 });
    expect(d.state.stakes[0]!.returnDeadlineRound).toBe(3);
    d.endPhase();
    expect(d.state.stakes[0]).toMatchObject({ returned: 0, returnTimedOut: true });
    d.reject({ type: 'return', seat: 1, stakeId: 'r3s0', amount: 1 }, 'stake_closed');
  });

  // SPEC §Vote: an exiled player can still return stakes they received before exile.
  it('is still allowed after the receiver is exiled', () => {
    const d = new Driver();
    d.goTo('deal', 2);
    d.act({ type: 'stake', seat: 0, to: 4, amount: 10 });
    d.goTo('vote', 2);
    d.exile(4, [0, 1, 2]);
    expect(d.state.seats[4]!.exiledRound).toBe(2);
    expect(d.view(4).prompts).toEqual([
      expect.objectContaining({ kind: 'return', stakeId: 'r2s0', max: 20, deadlineRound: 3 }),
    ]);
    d.goTo('deal', 3);
    const before = d.balance(0);
    d.act({ type: 'return', seat: 4, stakeId: 'r2s0', amount: 15 });
    expect(d.balance(0)).toBe(before + 15);
  });

  it('returns are capped at the receiver’s current balance', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 10 });
    d.state.seats[1]!.balance = 6;
    d.state.ledger.destroyed += 114;
    d.reject({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 7 }, 'insufficient_balance');
    d.act({ type: 'return', seat: 1, stakeId: 'r1s0', amount: 6 });
  });

  it('views never show stakes between other seats (CLAUDE.md invariant 4)', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 13 });
    for (const s of [2, 3, 4, 5] as const) {
      const v = d.view(s);
      expect(v.stakesSent).toEqual([]);
      expect(v.stakesReceived).toEqual([]);
      expect(JSON.stringify(v)).not.toContain('r1s0');
    }
    expect(d.view(0).stakesSent).toHaveLength(1);
    expect(d.view(1).stakesReceived).toHaveLength(1);
  });
});
