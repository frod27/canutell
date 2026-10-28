import type { Mode } from '@canutell/protocol';
import { auditMatch, deepAudit } from './audit';
import { runMatch, type SimMatchOptions } from './match';
import { StatsCollector, type Summary } from './stats';

export interface SimRunOptions {
  matches: number;
  mode: Mode;
  seed: string;
  timeoutPct: number;
  agentWeights: readonly number[];
  /** Deep-audit every Nth match (0 = never). */
  auditEvery: number;
  onProgress?: (done: number) => void;
}

export function runSimulation(o: SimRunOptions): Summary {
  const stats = new StatsCollector();
  const started = performance.now();
  for (let i = 0; i < o.matches; i++) {
    const opts: SimMatchOptions = {
      baseSeed: `${o.seed}:${o.mode}`,
      index: i,
      mode: o.mode,
      timeoutPct: o.timeoutPct,
      agentWeights: o.agentWeights,
      collectViews: true,
    };
    const result = runMatch(opts);
    stats.addViolations(auditMatch(result));
    if (o.auditEvery > 0 && i % o.auditEvery === 0) {
      stats.addViolations(deepAudit(opts, result));
      stats.deepAudited++;
    }
    stats.addMatch(result);
    if ((i + 1) % 1000 === 0) o.onProgress?.(i + 1);
  }
  return stats.summary(o.mode, (performance.now() - started) / 1000);
}
