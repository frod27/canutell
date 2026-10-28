import { describe, expect, it } from 'vitest';
import { GAMBLE_MENUS, gambleMenuFor } from '@canutell/protocol';
import type { SeatId } from '@canutell/protocol';
import { ALL, Driver, makeConfig } from './helpers';

describe('gamble menus — SPEC §Gamble', () => {
  it('full mode: risk in rounds 1, 3, 5; delay in 2, 4', () => {
    expect([1, 2, 3, 4, 5].map(gambleMenuFor)).toEqual(['risk', 'delay', 'risk', 'delay', 'risk']);
    const d = new Driver(makeConfig({ mode: 'full' }));
    const menus: string[] = [];
    for (let r = 1; r <= 5; r++) {
      d.goTo('gamble', r);
      const p = d.view(0).prompts.find((x) => x.kind === 'gamble');
      menus.push(p && p.kind === 'gamble' ? p.menu : 'none');
    }
    expect(menus).toEqual(['risk', 'delay', 'risk', 'delay', 'risk']);
  });

  it('quick mode: risk in rounds 1, 3; delay in 2', () => {
    const d = new Driver(makeConfig({ mode: 'quick' }));
    const menus: string[] = [];
    for (let r = 1; r <= 3; r++) {
      d.goTo('gamble', r);
      menus.push(d.state.rounds[r - 1]!.menu);
    }
    expect(menus).toEqual(['risk', 'delay', 'risk']);
  });

  it('menus match the SPEC table', () => {
    expect(GAMBLE_MENUS.risk).toEqual({
      A: { kind: 'sure', amount: 5 },
      B: { kind: 'chance', amount: 12, percent: 50 },
      C: { kind: 'chance', amount: 30, percent: 20 },
    });
    expect(GAMBLE_MENUS.delay).toEqual({
      A: { kind: 'now', amount: 5 },
      B: { kind: 'at_end', amount: 8 },
      C: { kind: 'at_end_if_not_exiled', amount: 12 },
    });
  });

  it('one private choice per active player, only in the Gamble phase', () => {
    const d = new Driver();
    d.reject({ type: 'gamble', seat: 0, option: 'A' }, 'wrong_phase');
    d.goTo('gamble', 1);
    d.act({ type: 'gamble', seat: 0, option: 'C' });
    d.reject({ type: 'gamble', seat: 0, option: 'A' }, 'already_acted');
    expect(d.view(1).myGambles).toEqual([]);
    expect(d.view(0).myGambles).toEqual([{ round: 1, menu: 'risk', option: 'C', immediate: null }]);
  });
});

describe('risk outcomes — SPEC §Gamble', () => {
  it('A pays +5 for sure', () => {
    const d = new Driver();
    d.goTo('gamble', 1);
    for (const s of ALL) d.act({ type: 'gamble', seat: s, option: 'A' });
    d.endPhase();
    for (const s of ALL) expect(d.balance(s)).toBe(105);
    expect(d.eventsOf('gamble_won')).toHaveLength(6);
  });

  it('B wins +12 about 50% and C wins +30 about 20% over seeded runs', () => {
    const N = 600;
    let bWins = 0;
    let cWins = 0;
    let bDraws = 0;
    let cDraws = 0;
    for (let i = 0; i < N; i++) {
      const d = new Driver(makeConfig(), `odds-${i}`);
      d.goTo('gamble', 1);
      for (const s of ALL) d.act({ type: 'gamble', seat: s, option: s < 3 ? 'B' : 'C' });
      d.endPhase();
      for (const s of ALL) {
        const won = d.balance(s) > 100;
        const amount = d.balance(s) - 100;
        if (s < 3) {
          bDraws++;
          if (won) bWins++;
          expect([0, 12]).toContain(amount);
        } else {
          cDraws++;
          if (won) cWins++;
          expect([0, 30]).toContain(amount);
        }
      }
      expect(d.eventsOf('gamble_won').length + d.eventsOf('gamble_lost').length).toBe(6);
    }
    // ±4 standard errors.
    expect(Math.abs(bWins / bDraws - 0.5)).toBeLessThan(4 * Math.sqrt(0.25 / bDraws));
    expect(Math.abs(cWins / cDraws - 0.2)).toBeLessThan(4 * Math.sqrt(0.16 / cDraws));
  });

  it('outcomes are fixed by the seed', () => {
    const run = () => {
      const d = new Driver(makeConfig(), 'fixed');
      d.goTo('gamble', 1);
      for (const s of ALL) d.act({ type: 'gamble', seat: s, option: 'C' });
      d.endPhase();
      return ALL.map((s) => d.balance(s));
    };
    expect(run()).toEqual(run());
  });
});

describe('delay payouts — SPEC §Gamble, §Vote', () => {
  function setup() {
    const d = new Driver(makeConfig({ mode: 'full' }));
    d.goTo('gamble', 2); // delay round
    const picks = ['A', 'B', 'C', 'C', 'B', 'C'] as const;
    for (const s of ALL) d.act({ type: 'gamble', seat: s, option: picks[s]! });
    d.endPhase();
    return d;
  }

  it('A pays +5 now; B and C pay nothing until match end', () => {
    const d = setup();
    const r2 = d.eventsOf('gamble_won').filter((e) => e.payload.round === 2);
    expect(r2.map((e) => e.seat)).toEqual([0]);
    expect(
      d.eventsOf('delay_scheduled').map((e) => [e.seat, e.payload.amount, e.payload.onlyIfNotExiled]),
    ).toEqual([
      [1, 8, false],
      [2, 12, true],
      [3, 12, true],
      [4, 8, false],
      [5, 12, true],
    ]);
    expect(d.eventsOf('delay_paid')).toHaveLength(0);
  });

  it('without exile: +8 and +12 are created at match end (delay_paid)', () => {
    const d = setup();
    d.goTo('final_ballot');
    const before = [1, 2, 3].map((s) => d.balance(s as SeatId));
    d.endPhase();
    expect([1, 2, 3].map((s) => d.state.reveal![s]!.delayPaid)).toEqual([8, 12, 12]);
    expect([1, 2, 3].map((s, i) => d.state.reveal![s]!.coinsBeforeReveal - before[i]!)).toEqual([0, 0, 0]);
    expect(d.eventsOf('delay_paid').map((e) => [e.seat, e.payload.created])).toEqual([
      [1, 8],
      [2, 12],
      [3, 12],
      [4, 8],
      [5, 12],
    ]);
  });

  it('with exile: the exiled seat forfeits +12 but keeps +8', () => {
    const d = setup();
    d.goTo('vote', 2);
    d.exile(5, [0, 1, 2]); // seat 5 chose C (+12 if not exiled)
    expect(d.eventsOf('delay_forfeited').map((e) => [e.seat, e.payload])).toEqual([
      [5, { round: 2, amount: 12, exiledRound: 2 }],
    ]);
    d.goTo('vote', 3);
    d.exile(4, [0, 1, 2]); // seat 4 chose B (+8 at match end)
    d.goTo('reveal');
    expect(d.state.reveal![5]!.delayPaid).toBe(0);
    expect(d.state.reveal![4]!.delayPaid).toBe(8);
    expect(d.state.delays.find((x) => x.seat === 5)!.status).toBe('forfeited');
    expect(d.view(5).myDelays).toEqual([
      { round: 2, option: 'C', amount: 12, onlyIfNotExiled: true, status: 'forfeited' },
    ]);
  });

  it('exile in the last round still forfeits +12', () => {
    const d = setup();
    d.goTo('vote', 5);
    d.exile(3, [0, 1, 2]);
    d.goTo('reveal');
    expect(d.state.reveal![3]!.delayPaid).toBe(0);
    expect(d.state.reveal![2]!.delayPaid).toBe(12);
  });
});
