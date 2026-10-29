import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSENT_TEXTS, consentMarkdown } from '../src';

// pnpm consent:docs — regenerate docs/consent/*.md from packages/protocol/src/consent.ts.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'consent');
mkdirSync(dir, { recursive: true });
for (const t of Object.values(CONSENT_TEXTS)) {
  writeFileSync(join(dir, `${t.type}-v${t.version}.md`), consentMarkdown(t));
  console.log(`wrote docs/consent/${t.type}-v${t.version}.md`);
}
