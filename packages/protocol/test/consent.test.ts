import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_TEXTS, CONSENT_VERSIONS, consentMarkdown } from '../src';

// SPEC §Consent and privacy: research use is a separate opt-in, and players see exactly what they agree to.
describe('consent texts', () => {
  it('docs/consent is up to date — run `pnpm consent:docs` if this fails', () => {
    for (const t of Object.values(CONSENT_TEXTS)) {
      const path = join(__dirname, '..', '..', '..', 'docs', 'consent', `${t.type}-v${t.version}.md`);
      expect(readFileSync(path, 'utf8')).toBe(consentMarkdown(t));
    }
  });

  it('match the required versions, and research consent is separate from the terms', () => {
    expect(CONSENT_TEXTS.terms.version).toBe(CONSENT_VERSIONS.terms);
    expect(CONSENT_TEXTS.research.version).toBe(CONSENT_VERSIONS.research);
    expect(CONSENT_TEXTS.terms.body.join(' ')).not.toMatch(/train/i);
    expect(CONSENT_TEXTS.research.body.join(' ')).toMatch(/change your mind/);
  });
});
