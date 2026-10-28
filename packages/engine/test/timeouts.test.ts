import { describe, expect, it } from 'vitest';
import { advancePhase } from '../src';
import { ALL, Driver, makeConfig } from './helpers';

// SPEC §Match structure "Timeouts": contribute 0, no stake, option A, skip vote, ballot blank —
// logged with timedOut = true, never as a real choice.

describe('timeouts — SPEC §Match structure', () => {
  it('a fully idle full-mode match: every decision is a default with timedOut = true', () => {
    const d = new Driver(makeConfig({ mode: 'full' }));
    d.goTo('reveal');
    const dec = d.decisions();
    // invest 6×5 + stake 6×5 + gamble 6×5 + vote 6×4 + ballot 6
    expect(dec).toHaveLength(120);
    for (const e of dec) {
      expect(e.payload.timedOut).toBe(true);
      expect(e.payload.decidedAt).toBe(e.serverTs);
    }
    const chosen = (kind: string) => new Set(d.decisions(kind).map((e) => JSON.stringify(e.payload.chosen)));
    expect(chosen('invest')).toEqual(new Set(['{"amount":0}']));
    expect(chosen('stake')).toEqual(new Set(['{"to":null,"amount":0}']));
    expect(chosen('gamble')).toEqual(new Set(['{"option":"A"}']));
    expect(chosen('vote')).toEqual(new Set(['{"target":null}']));
    expect(chosen('ballot')).toEqual(new Set(['{"labels":[]}']));
    // Idle players get +5 per round from option A and nothing else.
    expect(d.state.reveal!.map((r) => r.finalScore)).toEqual(ALL.map(() => 125));
  });

  it('a deliberate default choice is distinguishable from a timeout', () => {
    const d = new Driver(makeConfig({ mode: 'quick' }));
    const at = (seat: 0 | 1) => d.decisions().filter((e) => e.seat === seat);
    d.act({ type: 'invest', seat: 0, amount: 0 });
    d.endPhase();
    d.act({ type: 'stake', seat: 0, to: null, amount: 0 });
    d.endPhase();
    d.act({ type: 'gamble', seat: 0, option: 'A' });
    d.endPhase();
    d.goTo('vote', 2);
    d.act({ type: 'vote', seat: 0, target: null });
    d.goTo('final_ballot');
    d.act({ type: 'ballot', seat: 0, labels: [] });
    d.endPhase();
    const deliberate = at(0).filter((e) => !e.payload.timedOut);
    expect(deliberate.map((e) => e.payload.kind)).toEqual(['invest', 'stake', 'gamble', 'vote', 'ballot']);
    for (const e of deliberate) expect(e.payload.decidedAt).toBeLessThan(e.payload.phaseStartedAt + 60_000);
    // Same chosen values as seat 1's timeouts, but timedOut differs.
    for (const kind of ['invest', 'stake', 'gamble', 'vote', 'ballot']) {
      const mine = deliberate.find((e) => e.payload.kind === kind)!;
      const theirs = at(1).find((e) => e.payload.kind === kind && e.payload.round === mine.payload.round)!;
      expect(theirs.payload.chosen).toEqual(mine.payload.chosen);
      expect(theirs.payload.timedOut).toBe(true);
      expect(mine.payload.timedOut).toBe(false);
    }
  });

  it('timed-out decisions are stamped at the deadline, not at a late advancePhase call', () => {
    const d = new Driver();
    const deadline = d.state.deadline!;
    const r = advancePhase(d.state, deadline + 5_000);
    const decisions = r.events.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(6);
    for (const e of decisions) {
      expect(e.type === 'decision' && e.payload.decidedAt).toBe(deadline);
      expect(e.serverTs).toBe(deadline + 5_000);
    }
    // The next phase gets its full duration from when it actually started.
    expect(r.state.phaseStartedAt).toBe(deadline + 5_000);
    expect(r.state.deadline).toBe(deadline + 5_000 + 60_000);
  });

  it('timeouts carry option sets and state hashes like real decisions', () => {
    const d = new Driver();
    d.goTo('reveal');
    for (const e of d.decisions()) {
      expect(e.payload.stateHash).toMatch(/^[0-9a-f]{28}$/);
      expect(e.payload.optionSet).toBeDefined();
    }
  });
});
