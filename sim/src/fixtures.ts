import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeatViewSchema, type SeatView } from '@canutell/protocol';
import { runMatch } from './match';

// pnpm protocol:fixtures — record real per-seat views (every phase, every seat, both modes) from seeded
// sim matches into packages/protocol/fixtures/views.jsonl. Non-TypeScript clients (the Python agent
// service) test their policies against exactly what the server sends.

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'protocol',
  'fixtures',
  'views.jsonl',
);
const lines: string[] = [];
for (const mode of ['quick', 'full'] as const) {
  for (let i = 0; i < 2; i++) {
    const r = runMatch({
      baseSeed: 'fixtures',
      index: i,
      mode,
      timeoutPct: 5,
      agentWeights: [1, 1, 1],
      collectViews: true,
    });
    for (const pv of r.phaseViews) {
      for (const json of pv.views) {
        const view: SeatView = SeatViewSchema.parse(JSON.parse(json));
        if (view.prompts.length > 0) lines.push(JSON.stringify(view));
      }
    }
  }
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} views to packages/protocol/fixtures/views.jsonl`);
