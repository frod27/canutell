import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './sql';

// Applies supabase/migrations/NNNN_name.sql in order, each in its own transaction, recording each in
// schema_migrations. Every schema change is a new numbered file (CLAUDE.md); applied files are never
// edited. The Supabase CLI can apply the same files.

/** The repo's migrations, or CANUTELL_MIGRATIONS_DIR (bundled deployments copy them next to the bundle). */
export const MIGRATIONS_DIR =
  process.env.CANUTELL_MIGRATIONS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations');

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: f.slice(0, 4),
      name: f.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, f), 'utf8'),
    }));
}

/** Returns the versions applied by this call. */
export async function migrate(sql: Sql, migrations = loadMigrations()): Promise<string[]> {
  await sql.exec(`create table if not exists schema_migrations (
    version text primary key,
    name text not null,
    applied_at timestamptz not null default now()
  );
  alter table schema_migrations enable row level security`);
  const done = new Set(
    (await sql.query<{ version: string }>('select version from schema_migrations')).map((r) => r.version),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await sql.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
    });
    applied.push(m.version);
  }
  return applied;
}
