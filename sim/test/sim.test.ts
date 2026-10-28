import { describe, expect, it } from 'vitest';
import { auditMatch, deepAudit, runMatch, runSimulation, type SimMatchOptions } from '../src';

const opts = (index: number, mode: 'full' | 'quick' = 'full'): SimMatchOptions => ({
  baseSeed: 'test',
  index,
  mode,
  timeoutPct: 5,
  agentWeights: [1, 1, 1],
  collectViews: true,
});

describe('simulator', () => {
  it('runs seeded matches in both modes with zero invariant violations', () => {
    for (const mode of ['full', 'quick'] as const) {
      const s = runSimulation({
        matches: 60,
        mode,
        seed: 'ci',
        timeoutPct: 5,
        agentWeights: [1, 1, 1],
        auditEvery: 20,
      });
      expect(s.violations.byCheck).toEqual({});
      expect(s.violations.total).toBe(0);
      expect(s.matches).toBe(60);
      expect(s.deepAudited).toBe(3);
    }
  });

  it('is deterministic: the same seed reproduces the same summary', () => {
    const a = runSimulation({
      matches: 20,
      mode: 'quick',
      seed: 'det',
      timeoutPct: 5,
      agentWeights: [1, 1, 1],
      auditEvery: 0,
    });
    const b = runSimulation({
      matches: 20,
      mode: 'quick',
      seed: 'det',
      timeoutPct: 5,
      agentWeights: [1, 1, 1],
      auditEvery: 0,
    });
    expect({ ...a, seconds: 0 }).toEqual({ ...b, seconds: 0 });
  });

  it('exercises timeouts, cross-round returns, exiles, both reveal modes and masking', () => {
    const s = runSimulation({
      matches: 100,
      mode: 'full',
      seed: 'cover',
      timeoutPct: 5,
      agentWeights: [1, 1, 1],
      auditEvery: 0,
    });
    expect(s.decisions.timeoutShare).toBeGreaterThan(0);
    expect(s.exiles.matchesWithOneOrMore).toBeGreaterThan(0);
    expect(s.exiles.matchesWithZero).toBeGreaterThan(0);
    expect(Object.keys(s.revealModes).sort()).toEqual(['aggregate', 'individual']);
    expect(s.chat.masked).toBeGreaterThan(0);
    const r = runMatch(opts(1));
    const crossRound = r.events.some(
      (e) =>
        e.type === 'decision' &&
        e.payload.kind === 'return' &&
        !e.payload.timedOut &&
        e.payload.phase !== 'deal',
    );
    const anyCross =
      crossRound ||
      [2, 3, 4, 5, 6].some((i) =>
        runMatch(opts(i)).events.some(
          (e) => e.type === 'decision' && e.payload.kind === 'return' && e.payload.phase !== 'deal',
        ),
      );
    expect(anyCross).toBe(true);
  });
});

describe('the audit catches broken logs (it is not vacuous)', () => {
  const clean = runMatch(opts(7));

  it('a clean match passes the per-match and deep audits', () => {
    expect(auditMatch(clean)).toEqual([]);
    expect(deepAudit(opts(7), clean)).toEqual([]);
  });

  const tamper = (mutate: (r: ReturnType<typeof runMatch>) => void) => {
    const r = structuredClone(clean);
    mutate(r);
    return auditMatch(r).map((v) => v.check);
  };

  it('detects a coin created without a named event', () => {
    expect(
      tamper((r) => {
        const e = r.events.find((x) => x.type === 'gamble_won');
        if (e && e.type === 'gamble_won') e.payload.created += 1;
      }),
    ).toEqual(expect.arrayContaining(['log_rebuild']));
  });

  it('detects a missing decision', () => {
    expect(
      tamper((r) => {
        const i = r.events.findIndex((x) => x.type === 'decision' && x.payload.kind === 'invest');
        r.events.splice(i, 1);
      }),
    ).toEqual(expect.arrayContaining(['event_seq', 'decision_count']));
  });

  it('detects a timeout logged with a non-default choice', () => {
    expect(
      tamper((r) => {
        const e = r.events.find(
          (x) => x.type === 'decision' && x.payload.timedOut && x.payload.kind === 'gamble',
        );
        if (e && e.type === 'decision' && e.payload.kind === 'gamble') e.payload.chosen.option = 'C';
      }),
    ).toEqual(expect.arrayContaining(['timeout_default']));
  });

  it('detects a role leaking into a view', () => {
    expect(
      tamper((r) => {
        r.phaseViews[3]!.views[2] = r.phaseViews[3]!.views[2]!.replace(
          '"seats":[',
          '"seats":[{"isAgent":true},',
        );
      }),
    ).toEqual(expect.arrayContaining(['hidden_info']));
  });

  it('detects a wrong ballot payoff', () => {
    expect(
      tamper((r) => {
        const e = r.events.find((x) => x.type === 'ballot_scored');
        if (e && e.type === 'ballot_scored') e.payload.payoff += 1;
      }),
    ).toEqual(expect.arrayContaining(['ballot_payoff']));
  });
});
