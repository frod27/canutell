import { describe, expect, it } from 'vitest';
import { EventSchema } from '@canutell/protocol';
import { advancePhase, applyAction, replay, Rng } from '../src';
import { Driver, makeConfig, playMatchRandomly } from './helpers';

// CLAUDE.md invariant 1: same seed + same inputs = identical match, byte for byte.

function randomMatch(seed: string, inputSeed: string, mode: 'full' | 'quick' = 'full') {
  const d = new Driver(makeConfig({ mode, agents: [1] }), seed);
  playMatchRandomly(d, Rng.fromSeed(inputSeed), { chatPct: 40 });
  return d;
}

describe('deterministic replay — CLAUDE.md invariant 1', () => {
  it('two runs with the same seed and inputs produce byte-identical events and state', () => {
    for (const mode of ['full', 'quick'] as const) {
      for (let i = 0; i < 10; i++) {
        const a = randomMatch(`r-${i}`, `in-${i}`, mode);
        const b = randomMatch(`r-${i}`, `in-${i}`, mode);
        expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
        expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
      }
    }
  });

  it('replay() rebuilds the identical match from the recorded input log', () => {
    const a = randomMatch('rep', 'rep-in');
    const r = replay(a.config, a.seed, a.inputs);
    expect(JSON.stringify(r.events)).toBe(JSON.stringify(a.events));
    expect(JSON.stringify(r.state)).toBe(JSON.stringify(a.state));
  });

  it('the input log survives a JSON round trip (as it would through the database)', () => {
    const a = randomMatch('json', 'json-in');
    const inputs = JSON.parse(JSON.stringify(a.inputs));
    const r = replay(JSON.parse(JSON.stringify(a.config)), a.seed, inputs);
    expect(JSON.stringify(r.events)).toBe(JSON.stringify(a.events));
  });

  it('a state serialized mid-match resumes identically', () => {
    const a = randomMatch('mid', 'mid-in');
    const half = Math.floor(a.inputs.length / 2);
    const first = replay(a.config, a.seed, a.inputs.slice(0, half));
    let state = JSON.parse(JSON.stringify(first.state));
    const events = [...first.events];
    for (const input of a.inputs.slice(half)) {
      const t =
        input.kind === 'advance'
          ? advancePhase(state, input.now)
          : applyAction(state, input.action, input.now);
      state = t.state;
      events.push(...t.events);
    }
    expect(JSON.stringify(events)).toBe(JSON.stringify(a.events));
  });

  it('a different seed changes the RNG-driven parts of the match', () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const d = randomMatch(`seed-${i}`, 'same-inputs');
      outcomes.add(
        JSON.stringify([
          d.state.revealMode,
          d.eventsOf('gamble_won').map((e) => [e.seat, e.payload.created]),
        ]),
      );
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('the engine never mutates its input state', () => {
    const d = new Driver();
    const before = JSON.stringify(d.state);
    applyAction(d.state, { type: 'invest', seat: 0, amount: 5 }, d.t + 1);
    advancePhase(d.state, d.state.deadline!);
    expect(JSON.stringify(d.state)).toBe(before);
  });

  it('no transition in a full random match ever mutates an earlier state', () => {
    for (let m = 0; m < 3; m++) {
      const a = randomMatch(`immut-${m}`, `immut-in-${m}`);
      let { state } = replay(a.config, a.seed, []);
      const snapshots: [typeof state, string][] = [[state, JSON.stringify(state)]];
      for (const input of a.inputs) {
        const t =
          input.kind === 'advance'
            ? advancePhase(state, input.now)
            : applyAction(state, input.action, input.now);
        state = t.state;
        snapshots.push([state, JSON.stringify(state)]);
      }
      for (const [s, json] of snapshots) expect(JSON.stringify(s)).toBe(json);
    }
  });

  it('every logged event matches the protocol schema; seq is contiguous; serverTs is monotonic', () => {
    const a = randomMatch('schema', 'schema-in');
    a.events.forEach((e, i) => {
      EventSchema.parse(e);
      expect(e.seq).toBe(i);
      if (i > 0) expect(e.serverTs).toBeGreaterThanOrEqual(a.events[i - 1]!.serverTs);
    });
  });
});
