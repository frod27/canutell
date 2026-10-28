import { describe, expect, it } from 'vitest';
import { PHASE_DURATION_MS, SeatViewSchema } from '@canutell/protocol';
import { advancePhase, createMatch, drawAgentSeats } from '../src';
import { ALL, Driver, T0, makeConfig } from './helpers';

function phaseSequence(mode: 'full' | 'quick') {
  const d = new Driver(makeConfig({ mode }));
  const seq: string[] = [];
  while (d.phase !== 'reveal') {
    seq.push(`${d.round}:${d.phase}`);
    d.endPhase();
  }
  return { seq, d };
}

describe('match structure — SPEC §Match structure', () => {
  it('full mode: 5 rounds of Invest, Deal, Gamble, Vote (none in round 1), then Final ballot', () => {
    const { seq } = phaseSequence('full');
    expect(seq).toEqual([
      '1:invest',
      '1:deal',
      '1:gamble',
      '2:invest',
      '2:deal',
      '2:gamble',
      '2:vote',
      '3:invest',
      '3:deal',
      '3:gamble',
      '3:vote',
      '4:invest',
      '4:deal',
      '4:gamble',
      '4:vote',
      '5:invest',
      '5:deal',
      '5:gamble',
      '5:vote',
      '5:final_ballot',
    ]);
  });

  it('quick mode: 3 rounds', () => {
    const { seq } = phaseSequence('quick');
    expect(seq).toEqual([
      '1:invest',
      '1:deal',
      '1:gamble',
      '2:invest',
      '2:deal',
      '2:gamble',
      '2:vote',
      '3:invest',
      '3:deal',
      '3:gamble',
      '3:vote',
      '3:final_ballot',
    ]);
  });

  it('phase durations match the table; full ≈ 11.5 min, quick ≈ 7 min', () => {
    const full = phaseSequence('full').d;
    expect(full.t - T0).toBe(690_000); // 11.5 min
    const quick = phaseSequence('quick').d;
    expect(quick.t - T0).toBe(420_000); // 7 min
    for (const e of full.eventsOf('phase_started')) {
      expect(e.payload.deadline - e.payload.startedAt).toBe(PHASE_DURATION_MS[e.payload.phase]);
    }
  });

  it('createMatch is clock-free: lobby, no events; the first advancePhase logs match_created then Invest', () => {
    const { state, events } = createMatch(makeConfig(), 's');
    expect(state.phase).toBe('lobby');
    expect(events).toEqual([]);
    const r = advancePhase(state, 5);
    expect(r.events.map((e) => e.type)).toEqual(['match_created', 'phase_started']);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(r.state.phase).toBe('invest');
    expect(r.state.deadline).toBe(5 + PHASE_DURATION_MS.invest);
  });

  it('advancePhase is a no-op before the deadline and at Reveal', () => {
    const d = new Driver();
    const r = advancePhase(d.state, d.state.deadline! - 1);
    expect(r.state).toBe(d.state);
    expect(r.events).toEqual([]);
    d.goTo('reveal');
    expect(advancePhase(d.state, d.t + 10_000).events).toEqual([]);
  });

  it('actions at or after the deadline are rejected as late (CLAUDE.md invariant 5)', () => {
    const d = new Driver();
    d.reject({ type: 'invest', seat: 0, amount: 5 }, 'late', d.state.deadline!);
    d.reject({ type: 'invest', seat: 0, amount: 5 }, 'late', d.state.deadline! + 1);
    d.act({ type: 'invest', seat: 0, amount: 5 }, d.state.deadline! - 1 - d.t);
  });

  it('time cannot run backwards', () => {
    const d = new Driver();
    d.act({ type: 'invest', seat: 0, amount: 5 }, 100);
    d.reject({ type: 'invest', seat: 1, amount: 5 }, 'clock_regression', d.t - 1);
    expect(() => advancePhase(d.state, d.t - 1)).toThrow();
  });

  it('rejects actions in the lobby and after Reveal', () => {
    const { state } = createMatch(makeConfig(), 's');
    expect(() => advancePhase(state, 0)).not.toThrow();
    const d = new Driver();
    d.goTo('reveal');
    d.reject({ type: 'chat', seat: 0, channel: 'table', to: null, text: 'gg', client: null }, 'match_over');
  });

  it('reveal mode is drawn from the seed, about 50/50, and is fixed per seed', () => {
    let individual = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const a = createMatch(makeConfig(), `rm-${i}`).state.revealMode;
      expect(createMatch(makeConfig(), `rm-${i}`).state.revealMode).toBe(a);
      if (a === 'individual') individual++;
    }
    expect(individual / N).toBeGreaterThan(0.46);
    expect(individual / N).toBeLessThan(0.54);
  });

  it('seats 0, 1 or 2 agents with equal odds by default', () => {
    const counts = [0, 0, 0];
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const seats = drawAgentSeats(`ag-${i}`);
      expect(seats).toHaveLength(6);
      counts[seats.filter(Boolean).length]!++;
    }
    for (const c of counts) expect(c / N).toBeGreaterThan(0.3);
    expect(drawAgentSeats('x', [0, 0, 1]).filter(Boolean)).toHaveLength(2);
    expect(drawAgentSeats('x', [1, 0, 0]).filter(Boolean)).toHaveLength(0);
  });

  it('rejects configs with more than 2 agents or misordered seats', () => {
    expect(() => createMatch(makeConfig({ agents: [0, 1, 2] }), 's')).toThrow();
    const cfg = makeConfig();
    cfg.seats.reverse();
    expect(() => createMatch(cfg, 's')).toThrow();
  });

  it('every view parses against the protocol schema in every phase', () => {
    const d = new Driver(makeConfig({ agents: [2] }));
    while (true) {
      for (const s of ALL) SeatViewSchema.parse(d.view(s));
      if (d.phase === 'reveal') break;
      d.endPhase();
    }
  });
});
