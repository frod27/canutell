import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameJsonSchemas } from '../src';

// pnpm protocol:schema — regenerate packages/protocol/schema/*.json from the zod schemas.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
for (const [name, schema] of Object.entries(frameJsonSchemas())) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote schema/${name}.json`);
}
