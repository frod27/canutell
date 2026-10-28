import type { Mode } from '@canutell/protocol';
import type { Violation } from './audit';
import type { SimMatchResult } from './match';
import { POLICY_NAMES, type PolicyName } from '@canutell/bots';

interface PolicyStats {
  seats: number;
  finalScore: number;
  coinsBeforeReveal: number;
  humanSeats: number;
  humanFinalScore: number;
  exiled: number;
}

export interface Summary {
  mode: Mode;
  matches: number;
  seconds: number;
  violations: { total: number; byCheck: Record<string, { count: number; examples: string[] }> };
  deepAudited: number;
  policies: Record<
    PolicyName,
    {
      seats: number;
      avgFinalScore: number;
      avgCoinsBeforeReveal: number;
      avgHumanFinalScore: number | null;
      exileRate: number;
    }
  >;
  exiles: {
    perMatch: number;
    matchesWithZero: number;
    matchesWithOneOrMore: number;
    distribution: Record<string, number>;
    exiledWereAgents: number;
    exiledTotal: number;
  };
  decisions: {
    perMatch: Quantiles;
    deliberatePerMatch: Quantiles;
    histogram: Record<string, number>;
    timeoutShare: number;
  };
  revealModes: Record<string, number>;
  agentCounts: Record<string, number>;
  chat: { messages: number; masked: number };
}

interface Quantiles {
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

function quantiles(xs: number[]): Quantiles {
  if (xs.length === 0) return { min: 0, p10: 0, p50: 0, p90: 0, max: 0, mean: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    min: s[0]!,
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    max: s.at(-1)!,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

export class StatsCollector {
  private policy = new Map<PolicyName, PolicyStats>(
    POLICY_NAMES.map((p) => [
      p,
      { seats: 0, finalScore: 0, coinsBeforeReveal: 0, humanSeats: 0, humanFinalScore: 0, exiled: 0 },
    ]),
  );
  private violationsByCheck = new Map<string, { count: number; examples: string[] }>();
  private violationTotal = 0;
  private exileCounts: number[] = [];
  private exiledWereAgents = 0;
  private decisionCounts: number[] = [];
  private deliberateCounts: number[] = [];
  private timeouts = 0;
  private decisionsTotal = 0;
  private revealModes: Record<string, number> = {};
  private agentCounts: Record<string, number> = {};
  private chatMessages = 0;
  private chatMasked = 0;
  matches = 0;
  deepAudited = 0;

  addViolations(vs: Violation[]): void {
    for (const v of vs) {
      this.violationTotal++;
      const entry = this.violationsByCheck.get(v.check) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(v.detail);
      this.violationsByCheck.set(v.check, entry);
    }
  }

  addMatch(r: SimMatchResult): void {
    this.matches++;
    const reveal = r.state.reveal;
    if (!reveal) return; // engine error; already recorded as a violation
    r.policies.forEach((name, seat) => {
      const p = this.policy.get(name)!;
      const isAgent = r.config.seats[seat]!.isAgent;
      p.seats++;
      p.finalScore += reveal[seat]!.finalScore;
      p.coinsBeforeReveal += reveal[seat]!.coinsBeforeReveal;
      if (!isAgent) {
        p.humanSeats++;
        p.humanFinalScore += reveal[seat]!.finalScore;
      }
      if (r.state.seats[seat]!.exiledRound !== null) p.exiled++;
    });
    const exiled = r.state.seats.filter((s) => s.exiledRound !== null);
    this.exileCounts.push(exiled.length);
    this.exiledWereAgents += exiled.filter((s) => s.isAgent).length;
    let total = 0;
    let deliberate = 0;
    for (const e of r.events) {
      if (e.type === 'decision') {
        total++;
        if (e.payload.timedOut) this.timeouts++;
        else deliberate++;
      } else if (e.type === 'chat_message') {
        this.chatMessages++;
        if (e.payload.masked) this.chatMasked++;
      }
    }
    this.decisionsTotal += total;
    this.decisionCounts.push(total);
    this.deliberateCounts.push(deliberate);
    this.revealModes[r.state.revealMode] = (this.revealModes[r.state.revealMode] ?? 0) + 1;
    const agents = String(r.config.seats.filter((s) => s.isAgent).length);
    this.agentCounts[agents] = (this.agentCounts[agents] ?? 0) + 1;
  }

  summary(mode: Mode, seconds: number): Summary {
    const n = Math.max(1, this.exileCounts.length);
    const distribution: Record<string, number> = {};
    for (const c of this.exileCounts) distribution[String(c)] = (distribution[String(c)] ?? 0) + 1;
    const histogram: Record<string, number> = {};
    for (const c of this.decisionCounts) {
      const lo = Math.floor(c / 10) * 10;
      const key = `${lo}-${lo + 9}`;
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    const policies = {} as Summary['policies'];
    for (const [name, p] of this.policy) {
      policies[name] = {
        seats: p.seats,
        avgFinalScore: p.seats ? p.finalScore / p.seats : 0,
        avgCoinsBeforeReveal: p.seats ? p.coinsBeforeReveal / p.seats : 0,
        avgHumanFinalScore: p.humanSeats ? p.humanFinalScore / p.humanSeats : null,
        exileRate: p.seats ? p.exiled / p.seats : 0,
      };
    }
    const exiledTotal = this.exileCounts.reduce((a, b) => a + b, 0);
    return {
      mode,
      matches: this.matches,
      seconds,
      violations: { total: this.violationTotal, byCheck: Object.fromEntries(this.violationsByCheck) },
      deepAudited: this.deepAudited,
      policies,
      exiles: {
        perMatch: exiledTotal / n,
        matchesWithZero: this.exileCounts.filter((c) => c === 0).length,
        matchesWithOneOrMore: this.exileCounts.filter((c) => c > 0).length,
        distribution: Object.fromEntries(Object.entries(distribution).sort()),
        exiledWereAgents: this.exiledWereAgents,
        exiledTotal,
      },
      decisions: {
        perMatch: quantiles(this.decisionCounts),
        deliberatePerMatch: quantiles(this.deliberateCounts),
        histogram: Object.fromEntries(
          Object.entries(histogram).sort((a, b) => parseInt(a[0]) - parseInt(b[0])),
        ),
        timeoutShare: this.decisionsTotal ? this.timeouts / this.decisionsTotal : 0,
      },
      revealModes: this.revealModes,
      agentCounts: this.agentCounts,
      chat: { messages: this.chatMessages, masked: this.chatMasked },
    };
  }
}

const pct = (x: number, of: number) => (of ? `${((100 * x) / of).toFixed(1)}%` : '—');
const f1 = (x: number) => x.toFixed(1);

export function formatSummary(s: Summary): string {
  const out: string[] = [];
  const line = (t = '') => out.push(t);
  line(
    `CANUTELL simulator — mode ${s.mode}, ${s.matches} matches in ${s.seconds.toFixed(1)}s (${(s.matches / s.seconds).toFixed(0)}/s)`,
  );
  line();
  line(`INVARIANT VIOLATIONS: ${s.violations.total}${s.violations.total === 0 ? '  ✓' : '  ✗'}`);
  line(
    `  every match: conservation, log rebuild, decisions, timeouts, pot, gamble, vote, exile, ballots, hidden-info scan`,
  );
  line(
    `  deep audit (${s.deepAudited} matches): replay determinism, schema validation, role counterfactuals`,
  );
  for (const [check, v] of Object.entries(s.violations.byCheck)) {
    line(`  ${check}: ${v.count}`);
    for (const ex of v.examples) line(`      e.g. ${ex}`);
  }
  line();
  line('AVERAGE FINAL SCORE BY POLICY (coins + delays + exile bonus + ballot)');
  line(
    `  ${'policy'.padEnd(18)}${'seats'.padStart(8)}${'final'.padStart(9)}${'pre-reveal'.padStart(12)}${'human-only'.padStart(12)}${'exiled'.padStart(9)}`,
  );
  for (const [name, p] of Object.entries(s.policies)) {
    line(
      `  ${name.padEnd(18)}${String(p.seats).padStart(8)}${f1(p.avgFinalScore).padStart(9)}${f1(p.avgCoinsBeforeReveal).padStart(12)}${(p.avgHumanFinalScore === null ? '—' : f1(p.avgHumanFinalScore)).padStart(12)}${pct(p.exileRate, 1).padStart(9)}`,
    );
  }
  line();
  line('EXILES');
  line(`  exiles per match: ${s.exiles.perMatch.toFixed(3)}`);
  line(`  matches with 0 exiles:  ${s.exiles.matchesWithZero} (${pct(s.exiles.matchesWithZero, s.matches)})`);
  line(
    `  matches with 1+ exiles: ${s.exiles.matchesWithOneOrMore} (${pct(s.exiles.matchesWithOneOrMore, s.matches)})`,
  );
  line(
    `  distribution: ${Object.entries(s.exiles.distribution)
      .map(([k, v]) => `${k}→${v}`)
      .join('  ')}`,
  );
  line(
    `  exiled seats that were agents: ${s.exiles.exiledWereAgents}/${s.exiles.exiledTotal} (bots ignore roles, so this tracks the base rate)`,
  );
  line();
  line('MATCH LENGTH IN DECISIONS (all logged decisions, incl. timeouts and returns)');
  const q = s.decisions.perMatch;
  line(`  min ${q.min}  p10 ${q.p10}  median ${q.p50}  p90 ${q.p90}  max ${q.max}  mean ${f1(q.mean)}`);
  const dq = s.decisions.deliberatePerMatch;
  line(
    `  deliberate only: min ${dq.min}  median ${dq.p50}  max ${dq.max}  mean ${f1(dq.mean)}   timeouts ${pct(s.decisions.timeoutShare, 1)}`,
  );
  const maxBucket = Math.max(...Object.values(s.decisions.histogram));
  for (const [bucket, count] of Object.entries(s.decisions.histogram)) {
    line(`  ${bucket.padStart(9)} ${'█'.repeat(Math.max(1, Math.round((40 * count) / maxBucket)))} ${count}`);
  }
  line();
  line(
    `reveal modes: ${Object.entries(s.revealModes)
      .map(([k, v]) => `${k} ${pct(v, s.matches)}`)
      .join(', ')}`,
  );
  line(
    `agent counts: ${Object.entries(s.agentCounts)
      .sort()
      .map(([k, v]) => `${k}→${pct(v, s.matches)}`)
      .join(', ')}`,
  );
  line(`chat: ${s.chat.messages} messages, ${s.chat.masked} masked`);
  return out.join('\n');
}
