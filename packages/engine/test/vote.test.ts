import { describe, expect, it } from 'vitest';
import type { SeatId } from '@canutell/protocol';
import { exileOutcome } from '../src';
import { Driver, makeConfig } from './helpers';

describe('exile threshold — SPEC §Vote', () => {
  it.each([
    [[0, 0, 0, 0, 0, 0], null, 'no votes'],
    [[2, 0, 0, 0, 0, 0], null, '2 votes is below the threshold'],
    [[3, 0, 0, 0, 0, 0], 0, '3 votes, unique max'],
    [[3, 2, 1, 0, 0, 0], 0, '3 vs 2'],
    [[3, 3, 0, 0, 0, 0], null, '3–3 tie'],
    [[0, 0, 0, 0, 4, 2], 4, '4 vs 2'],
    [[1, 1, 1, 1, 1, 1], null, 'all tied at 1'],
    [[0, 2, 2, 2, 0, 0], null, 'three-way tie at 2'],
    [[0, 0, 6, 0, 0, 0], 2, 'unanimous'],
  ])('%j → %s (%s)', (tally, expected, _why) => {
    expect(exileOutcome(tally)).toBe(expected);
  });

  it('exiles with 3 votes and a strict lead, live', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.act({ type: 'vote', seat: 0, target: 3 });
    d.act({ type: 'vote', seat: 1, target: 3 });
    d.act({ type: 'vote', seat: 2, target: 3 });
    d.act({ type: 'vote', seat: 3, target: 0 });
    d.act({ type: 'vote', seat: 4, target: 0 });
    d.act({ type: 'vote', seat: 5, target: null });
    d.endPhase();
    expect(d.eventsOf('vote_resolved')[0]!.payload).toEqual({
      round: 2,
      tally: [2, 0, 0, 3, 0, 0],
      exiled: 3,
    });
    expect(d.state.seats[3]!.exiledRound).toBe(2);
    expect(d.eventsOf('seat_exiled')[0]).toMatchObject({ seat: 3, payload: { round: 2, votes: 3 } });
  });

  it('a 3–3 tie exiles no one', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    for (const s of [0, 1, 2] as SeatId[]) d.act({ type: 'vote', seat: s, target: 4 });
    for (const s of [3, 4, 5] as SeatId[]) d.act({ type: 'vote', seat: s, target: 0 });
    d.endPhase();
    expect(d.eventsOf('vote_resolved')[0]!.payload).toEqual({
      round: 2,
      tally: [3, 0, 0, 0, 3, 0],
      exiled: null,
    });
    expect(d.eventsOf('seat_exiled')).toEqual([]);
    expect(d.state.seats.every((s) => s.exiledRound === null)).toBe(true);
  });

  it('timeouts and skips do not count as votes', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.act({ type: 'vote', seat: 0, target: 1 });
    d.act({ type: 'vote', seat: 2, target: 1 });
    d.act({ type: 'vote', seat: 3, target: null });
    d.endPhase();
    expect(d.eventsOf('vote_resolved')[0]!.payload).toEqual({
      round: 2,
      tally: [0, 2, 0, 0, 0, 0],
      exiled: null,
    });
  });

  it('there is no Vote in round 1', () => {
    const d = new Driver();
    d.goTo('gamble', 1);
    d.endPhase();
    expect(d.phase).toBe('invest');
    expect(d.round).toBe(2);
  });

  it('only active players vote, only for another active player', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.reject({ type: 'vote', seat: 0, target: 0 }, 'invalid_target');
    d.exile(5, [0, 1, 2]);
    d.goTo('vote', 3);
    d.reject({ type: 'vote', seat: 0, target: 5 }, 'invalid_target');
    d.reject({ type: 'vote', seat: 5, target: 0 }, 'not_active');
  });

  it('an exiled player takes no further Invest, Deal, Gamble or Vote actions', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.exile(2, [0, 1, 3]);
    d.goTo('invest', 3);
    d.reject({ type: 'invest', seat: 2, amount: 1 }, 'not_active');
    expect(d.view(2).prompts.filter((p) => p.kind !== 'return')).toEqual([]);
    d.goTo('deal', 3);
    d.reject({ type: 'stake', seat: 2, to: 0, amount: 1 }, 'not_active');
    d.reject({ type: 'stake', seat: 2, to: null, amount: 0 }, 'not_active');
    d.goTo('gamble', 3);
    d.reject({ type: 'gamble', seat: 2, option: 'A' }, 'not_active');
    d.goTo('vote', 3);
    d.reject({ type: 'vote', seat: 2, target: null }, 'not_active');
    // ...and gets no timeout decisions either.
    const r3 = d.decisions().filter((e) => e.payload.round === 3 && e.seat === 2);
    expect(r3).toEqual([]);
    // The exiled player keeps their coins.
    expect(d.balance(2)).toBeGreaterThan(0);
  });

  it('exiled players still fill a Final ballot', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.exile(2, [0, 1, 3]);
    d.goTo('final_ballot');
    expect(d.view(2).prompts).toEqual([{ kind: 'ballot', targets: [0, 1, 3, 4, 5] }]);
    d.act({ type: 'ballot', seat: 2, labels: [{ target: 0, label: 'agent', confidence: 70 }] });
  });

  it('views show the outcome only: no tallies and no one else’s vote before Reveal', () => {
    const d = new Driver(makeConfig({ agents: [1] }));
    d.goTo('vote', 2);
    d.act({ type: 'vote', seat: 0, target: 1 });
    d.act({ type: 'vote', seat: 2, target: 1 });
    d.act({ type: 'vote', seat: 3, target: 1 });
    d.act({ type: 'vote', seat: 4, target: 5 });
    expect(d.view(5).myVotes).toEqual([]);
    d.endPhase();
    const v = d.view(5);
    expect(v.voteResults).toEqual([{ round: 2, exiled: 1 }]);
    expect(v.myVotes).toEqual([{ round: 2, target: null }]);
    expect(JSON.stringify(v)).not.toContain('tally');
    expect(d.view(0).myVotes).toEqual([{ round: 2, target: 1 }]);
    // Exile is public; the exiled seat's role is not.
    expect(v.seats[1]).toEqual({ seatId: 1, exiledRound: 2 });
    expect(JSON.stringify(v)).not.toMatch(/isAgent|agentVersion|baseline/);
  });
});
