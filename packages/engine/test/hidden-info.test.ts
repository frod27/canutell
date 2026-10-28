import { describe, expect, it } from 'vitest';
import type { SeatId } from '@canutell/protocol';
import { Rng } from '../src';
import { ALL, Driver, makeConfig, playPhaseRandomly } from './helpers';

// CLAUDE.md invariants 4 and 7; SPEC §Vote ("exiled player's role is not revealed until Reveal").

const ROLE_LAYOUTS: SeatId[][] = [[], [0], [3], [1, 4], [2, 5]];
const FORBIDDEN = /isAgent|agentVersion|agentCount|agent_count|baseline-|targetIsAgent/;

describe('hidden roles — CLAUDE.md invariants 4 & 7', () => {
  it('views are byte-identical whatever the roles (incl. agent count) until Reveal', () => {
    for (let m = 0; m < 8; m++) {
      const seed = `hidden-${m}`;
      const drivers = ROLE_LAYOUTS.map((agents) => new Driver(makeConfig({ agents }), seed));
      const rngs = ROLE_LAYOUTS.map(() => Rng.fromSeed(`inputs-${m}`));
      let steps = 0;
      const over = () => drivers[0]!.state.phase === 'reveal';
      while (!over()) {
        // Same seeded inputs into every layout; compare all views after each phase.
        drivers.forEach((d, i) => playPhaseRandomly(d, rngs[i]!, { skipPct: 10, chatPct: 30 }));
        if (over()) break;
        for (const seat of ALL) {
          const reference = JSON.stringify(drivers[0]!.view(seat));
          expect(reference).not.toMatch(FORBIDDEN);
          for (const d of drivers.slice(1)) expect(JSON.stringify(d.view(seat))).toBe(reference);
        }
        steps++;
      }
      expect(steps).toBeGreaterThan(5);
    }
  }, 60_000);

  it('checks views after every single action too (one match)', () => {
    const a = new Driver(makeConfig({ agents: [] }), 'fine');
    const b = new Driver(makeConfig({ agents: [2, 4] }), 'fine');
    const ra = Rng.fromSeed('fine-in');
    const rb = Rng.fromSeed('fine-in');
    const snapshots: string[][] = [];
    while (a.phase !== 'reveal') {
      playPhaseRandomly(a, ra, {
        onStep: () => {
          if (a.phase !== 'reveal') snapshots.push(ALL.map((s) => JSON.stringify(a.view(s))));
        },
      });
    }
    let i = 0;
    while (b.phase !== 'reveal') {
      playPhaseRandomly(b, rb, {
        onStep: () => {
          if (b.phase !== 'reveal') {
            const snap = ALL.map((s) => JSON.stringify(b.view(s)));
            expect(snap).toEqual(snapshots[i]);
            for (const v of snap) expect(v).not.toMatch(FORBIDDEN);
            i++;
          }
        },
      });
    }
    expect(i).toBe(snapshots.length);
  });

  it('state hashes in decision events do not depend on roles', () => {
    const run = (agents: SeatId[]) => {
      const d = new Driver(makeConfig({ agents }), 'hash');
      const rng = Rng.fromSeed('hash-in');
      while (d.phase !== 'reveal') playPhaseRandomly(d, rng);
      return d.decisions().map((e) => e.payload.stateHash);
    };
    expect(run([1, 3])).toEqual(run([]));
  });

  it('roles appear only at Reveal', () => {
    const d = new Driver(makeConfig({ agents: [4] }));
    d.goTo('final_ballot');
    for (const s of ALL) expect(d.view(s).reveal).toBeNull();
    d.endPhase();
    for (const s of ALL) expect(d.view(s).reveal!.seats[4]!.isAgent).toBe(true);
  });
});

describe('other seats’ private choices — CLAUDE.md invariant 4', () => {
  it('ballots: no seat sees another seat’s ballot before Reveal', () => {
    const d = new Driver();
    d.goTo('final_ballot');
    d.act({ type: 'ballot', seat: 0, labels: [{ target: 1, label: 'agent', confidence: 87 }] });
    expect(d.view(0).myBallot).toEqual({ labels: [{ target: 1, label: 'agent', confidence: 87 }] });
    for (const s of [1, 2, 3, 4, 5] as SeatId[]) {
      const v = d.view(s);
      expect(v.myBallot).toBeNull();
      expect(JSON.stringify(v)).not.toContain('87');
    }
  });

  it('aggregate-mode contributions, gambles and stakes of others never appear', () => {
    let seed = '';
    for (let i = 0; ; i++) {
      const d = new Driver(makeConfig(), `agg-${i}`);
      if (d.state.revealMode === 'aggregate') {
        seed = `agg-${i}`;
        break;
      }
    }
    const d = new Driver(makeConfig(), seed);
    d.act({ type: 'invest', seat: 0, amount: 17 });
    d.endPhase();
    d.act({ type: 'stake', seat: 0, to: 1, amount: 19 });
    d.endPhase();
    d.act({ type: 'gamble', seat: 0, option: 'C' });
    d.endPhase();
    const v = d.view(3);
    expect(v.investResults[0]!.contributions).toBeNull();
    expect(v.myGambles).toEqual([{ round: 1, menu: 'risk', option: 'A', immediate: 5 }]);
    expect(v.stakesSent).toEqual([]);
    expect(v.stakesReceived).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/"amount":17|"sent":19|"option":"C"/);
  });
});
