import { parseArgs } from 'node:util';
import { ModeSchema, type Mode } from '@canutell/protocol';
import { runSimulation } from './run';
import { formatSummary } from './stats';

const USAGE = `Usage: pnpm sim [--matches N] [--mode full|quick|both] [--seed S] [--timeout-pct P]
                [--agents W0,W1,W2] [--audit-every N] [--json]

  --matches      matches per mode (default 1000)
  --mode         full, quick or both (default full)
  --seed         base seed; same seed → identical run (default "canutell")
  --timeout-pct  chance a bot lets any given decision time out (default 5)
  --agents       relative weights for seating 0,1,2 agents (default 1,1,1)
  --audit-every  deep-audit every Nth match: replay, schemas, role counterfactuals (default 100, 0 = off)
  --json         print the summary as JSON

Exit code 1 if any invariant violation is found.`;

function main(): number {
  // pnpm forwards a literal "--" when called as `pnpm sim -- --matches 10`; drop it.
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      matches: { type: 'string', default: '1000' },
      mode: { type: 'string', default: 'full' },
      seed: { type: 'string', default: 'canutell' },
      'timeout-pct': { type: 'string', default: '5' },
      agents: { type: 'string', default: '1,1,1' },
      'audit-every': { type: 'string', default: '100' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const int = (name: string, raw: string, min: number, max: number) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`--${name} must be an integer in [${min}, ${max}]`);
    return n;
  };
  const matches = int('matches', values.matches, 1, 10_000_000);
  const timeoutPct = int('timeout-pct', values['timeout-pct'], 0, 100);
  const auditEvery = int('audit-every', values['audit-every'], 0, 10_000_000);
  const agentWeights = values.agents.split(',').map((w) => int('agents', w, 0, 1000));
  if (agentWeights.length !== 3 || agentWeights.every((w) => w === 0))
    throw new Error('--agents needs three weights, not all 0');
  const modes: Mode[] = values.mode === 'both' ? ['full', 'quick'] : [ModeSchema.parse(values.mode)];

  let violations = 0;
  const summaries = [];
  for (const mode of modes) {
    const summary = runSimulation({
      matches,
      mode,
      seed: values.seed,
      timeoutPct,
      agentWeights,
      auditEvery,
      onProgress: (done) => process.stderr.write(`  ${mode}: ${done}/${matches}\r`),
    });
    process.stderr.write(' '.repeat(40) + '\r');
    violations += summary.violations.total;
    summaries.push(summary);
    if (!values.json) console.log(formatSummary(summary) + '\n');
  }
  if (values.json) console.log(JSON.stringify(summaries.length === 1 ? summaries[0] : summaries, null, 2));
  return violations === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error((e as Error).message);
  console.error(USAGE);
  process.exitCode = 2;
}
