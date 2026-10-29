// pnpm --filter @canutell/server build — bundle the game server and the database CLI for deployment
// (docs/ALPHA.md). Everything, workspace packages included, goes into two ESM files; the migrations are
// copied next to them (the server refuses to start with pending migrations).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const out = join(here, '..', 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    server: join(here, '..', 'src', 'main.ts'),
    'db-cli': join(root, 'packages', 'db', 'src', 'cli.ts'),
  },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Optional native add-ons that the libraries load only if present.
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (pg, ws) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
cpSync(join(root, 'supabase', 'migrations'), join(out, 'migrations'), { recursive: true });
console.log('copied supabase/migrations → dist/migrations (set CANUTELL_MIGRATIONS_DIR)');
