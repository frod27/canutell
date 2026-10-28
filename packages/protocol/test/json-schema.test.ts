import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameJsonSchemas } from '../src';

describe('committed JSON Schemas (used by the Python agent service)', () => {
  it('are up to date with the zod schemas — run `pnpm protocol:schema` if this fails', () => {
    for (const [name, schema] of Object.entries(frameJsonSchemas())) {
      const committed = JSON.parse(readFileSync(join(__dirname, '..', 'schema', `${name}.json`), 'utf8'));
      expect(committed).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});
