import { describe, expect, it } from 'vitest';
import { RevealViewSchema } from '@canutell/protocol';
import type { SeatId } from '@canutell/protocol';
import { Driver, makeConfig } from './helpers';

/**
 * Agents are seats 1 and 2.
 * Round 2: seat 3 (human) is exiled by votes from 0, 1 (agent), 4. Seat 5 votes for 0 (not exiled).
 * Round 3: seat 2 (agent) is exiled by votes from 0, 4, 5. Seat 1 votes for 0 (not exiled).
 */
function scenario() {
  const d = new Driver(makeConfig({ agents: [1, 2] }));
  d.goTo('vote', 2);
  for (const v of [0, 1, 4] as SeatId[]) d.act({ type: 'vote', seat: v, target: 3 });
  d.act({ type: 'vote', seat: 5, target: 0 });
  d.endPhase();
  d.goTo('vote', 3);
  for (const v of [0, 4, 5] as SeatId[]) d.act({ type: 'vote', seat: v, target: 2 });
  d.act({ type: 'vote', seat: 1, target: 0 });
  d.endPhase();
  d.goTo('final_ballot');
  d.act({
    type: 'ballot',
    seat: 0,
    labels: [
      { target: 5, label: 'human', confidence: 50 }, // +20
      { target: 1, label: 'agent', confidence: 100 }, // +30
      { target: 2, label: 'agent', confidence: 75 }, // +28 (27.5)
      { target: 3, label: 'human', confidence: 100 }, // +30
      { target: 4, label: 'agent', confidence: 100 }, // −10
    ],
  });
  d.act({ type: 'ballot', seat: 1, labels: [{ target: 0, label: 'human', confidence: 100 }] }); // agent: not applied
  d.act({ type: 'ballot', seat: 3, labels: [{ target: 2, label: 'agent', confidence: 100 }] }); // exiled human: +30
  d.act({ type: 'ballot', seat: 4, labels: [] }); // deliberately blank
  const coinsBefore = d.state.seats.map((s) => s.balance);
  d.endPhase();
  return { d, coinsBefore };
}

describe('exile bonus — SPEC §Scoring (humans)', () => {
  // DECISIONS 2026-10-28 "Exile bonus": only votes for the seat actually exiled that round count.
  it('+10 per human vote that exiled an agent, −5 per human vote that exiled a human; agents get none', () => {
    const { d } = scenario();
    const bonuses = d
      .eventsOf('exile_bonus')
      .map((e) => [e.seat, e.payload.round, e.payload.target, e.payload.delta]);
    expect(bonuses).toEqual([
      [0, 2, 3, -5],
      [4, 2, 3, -5],
      [0, 3, 2, 10],
      [4, 3, 2, 10],
      [5, 3, 2, 10],
    ]);
    expect(d.state.reveal!.map((r) => r.exileBonus)).toEqual([5, 0, 0, 0, 5, 10]);
  });
});

describe('final ballot & scoring — SPEC §Final ballot, §Scoring (humans)', () => {
  it('scores each non-blank label for humans; agent ballots are logged, never applied', () => {
    const { d } = scenario();
    const scored = d
      .eventsOf('ballot_scored')
      .map((e) => [e.seat, e.payload.target, e.payload.payoff, e.payload.applied]);
    expect(scored).toEqual([
      [0, 1, 30, true],
      [0, 2, 28, true],
      [0, 3, 30, true],
      [0, 4, -10, true],
      [0, 5, 20, true],
      [1, 0, 30, false],
      [3, 2, 30, true],
    ]);
    expect(d.state.reveal!.map((r) => r.ballotPayoff)).toEqual([98, 0, 0, 30, 0, 0]);
  });

  it('final score = coins + delayed payouts + exile bonuses + ballot payoff', () => {
    const { d, coinsBefore } = scenario();
    d.state.reveal!.forEach((r, seat) => {
      expect(r.coinsBeforeReveal).toBe(coinsBefore[seat]);
      expect(r.finalScore).toBe(r.coinsBeforeReveal + r.delayPaid + r.exileBonus + r.ballotPayoff);
      expect(d.state.seats[seat]!.balance).toBe(r.finalScore);
    });
    expect(d.eventsOf('match_ended')[0]!.payload.finalScores).toEqual(
      d.state.reveal!.map((r) => r.finalScore),
    );
  });

  it('blank ballots score 0; timeouts are blank and logged timedOut', () => {
    const { d } = scenario();
    const ballots = d.decisions('ballot');
    expect(ballots).toHaveLength(6);
    const bySeat = new Map(ballots.map((e) => [e.seat, e.payload]));
    expect(bySeat.get(4)).toMatchObject({ timedOut: false, chosen: { labels: [] } });
    expect(bySeat.get(2)).toMatchObject({ timedOut: true, chosen: { labels: [] } });
    expect(bySeat.get(5)).toMatchObject({ timedOut: true, chosen: { labels: [] } });
    expect(d.state.reveal![4]!.ballotPayoff).toBe(0);
  });

  it('validates ballots: other seats only, once each, confidence 50–100, one submission, in phase', () => {
    const d = new Driver();
    d.reject({ type: 'ballot', seat: 0, labels: [] }, 'wrong_phase');
    d.goTo('final_ballot');
    d.reject(
      { type: 'ballot', seat: 0, labels: [{ target: 0, label: 'agent', confidence: 60 }] },
      'invalid_target',
    );
    d.reject(
      {
        type: 'ballot',
        seat: 0,
        labels: [
          { target: 1, label: 'agent', confidence: 60 },
          { target: 1, label: 'human', confidence: 60 },
        ],
      },
      'invalid_target',
    );
    d.reject(
      { type: 'ballot', seat: 0, labels: [{ target: 1, label: 'agent', confidence: 49 }] },
      'invalid_action',
    );
    d.reject(
      { type: 'ballot', seat: 0, labels: [{ target: 1, label: 'robot', confidence: 60 }] } as never,
      'invalid_action',
    );
    d.act({ type: 'ballot', seat: 0, labels: [{ target: 1, label: 'agent', confidence: 60 }] });
    d.reject({ type: 'ballot', seat: 0, labels: [] }, 'already_acted');
  });

  it('final scores may go negative at Reveal (DECISIONS "Negative final scores")', () => {
    const d = new Driver(makeConfig({ agents: [5] }));
    d.goTo('final_ballot');
    d.state.ledger.destroyed += d.state.seats[0]!.balance;
    d.state.seats[0]!.balance = 0;
    d.act({
      type: 'ballot',
      seat: 0,
      labels: [1, 2, 3, 4].map((t) => ({ target: t, label: 'agent' as const, confidence: 100 })),
    });
    d.endPhase();
    expect(d.state.reveal![0]!.finalScore).toBe(-40);
  });
});

describe('reveal — SPEC §Reveal', () => {
  it('shows every seat’s role and agent version, ballot accuracy, final scores and key moments', () => {
    const { d } = scenario();
    const r = d.view(4).reveal!;
    RevealViewSchema.parse(r);
    expect(r.seats.map((s) => [s.isAgent, s.agentVersion])).toEqual([
      [false, null],
      [true, 'baseline-0'],
      [true, 'baseline-0'],
      [false, null],
      [false, null],
      [false, null],
    ]);
    expect(r.seats[0]!.ballotAccuracy).toEqual({ labeled: 5, correct: 4 });
    expect(r.seats[1]!.ballotAccuracy).toEqual({ labeled: 1, correct: 1 });
    expect(r.keyMoments.exiles).toEqual([
      { round: 2, seat: 3, isAgent: false },
      { round: 3, seat: 2, isAgent: true },
    ]);
    expect(r.votes.map((v) => [v.round, v.exiled])).toEqual([
      [2, 3],
      [3, 2],
      [4, null],
      [5, null],
    ]);
    expect(r.ballots[1]!.labels[0]).toMatchObject({ payoff: 30, applied: false });
  });

  it('lists the biggest stake and unreturned stakes', () => {
    const d = new Driver();
    d.goTo('deal', 1);
    d.act({ type: 'stake', seat: 0, to: 1, amount: 18 });
    d.act({ type: 'stake', seat: 2, to: 3, amount: 4 });
    d.act({ type: 'return', seat: 3, stakeId: 'r1s2', amount: 8 });
    d.goTo('reveal');
    const km = d.view(0).reveal!.keyMoments;
    expect(km.biggestStake).toMatchObject({ stakeId: 'r1s0', sent: 18, returned: 0 });
    expect(km.unreturnedStakes.map((s) => s.stakeId)).toEqual(['r1s0']);
  });
});
