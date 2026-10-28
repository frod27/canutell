import { resolve } from 'node:path';
import {
  PostgresStore,
  dbRevealSource,
  loadMigrations,
  pgSql,
  type RevealSource,
  type Sql,
} from '@canutell/db';
import { ScaledClock } from './clock';
import { startGameServer } from './server';
import { JsonlStore, type MatchStore } from './store';

// Entry point: `pnpm serve`. Configuration via environment variables:
//   PORT           listen port (default 8787)
//   HOST           listen address (default 0.0.0.0)
//   DATABASE_URL   Postgres (local or Supabase). When set, matches go to Postgres and reveals can be reopened.
//   DATA_DIR       without DATABASE_URL: where JSONL match logs are written (default ./data/matches)
//   CLOCK_SPEED    virtual ms per real ms; >1 only for testing (default 1)
//   FILL_BOTS_MS   dev only: fill waiting queues/parties with bots after this many ms (default off)
//   AGENT_WEIGHTS  relative odds of 0,1,2 agents (default 1,1,1)
//   CORS_ORIGIN    allowed origin for the HTTP API (default *)

const env = process.env;
const speed = Number(env.CLOCK_SPEED ?? 1);
const fill = env.FILL_BOTS_MS ? Number(env.FILL_BOTS_MS) : null;
const weights = (env.AGENT_WEIGHTS ?? '1,1,1').split(',').map(Number);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const clock = new ScaledClock(speed);

let store: MatchStore;
let reveals: RevealSource | undefined;
let sql: Sql | null = null;
if (env.DATABASE_URL) {
  sql = pgSql(env.DATABASE_URL);
  // Refuse to run against a schema that is behind: migrations are applied deliberately (pnpm db:migrate).
  const applied = new Set(
    (await sql.query<{ version: string }>('select version from schema_migrations').catch(() => [])).map(
      (r) => r.version,
    ),
  );
  const pending = loadMigrations().filter((m) => !applied.has(m.version));
  if (pending.length > 0) {
    console.error(
      `database has pending migrations: ${pending.map((m) => m.name).join(', ')} — run pnpm db:migrate`,
    );
    process.exit(1);
  }
  const aborted = await PostgresStore.recover(sql, clock.now());
  if (aborted > 0) log(`marked ${aborted} interrupted match(es) aborted`);
  store = new PostgresStore(sql, {
    onError: (id, e) => log(`DB WRITE FAILED for match ${id}: ${String(e)}`),
  });
  reveals = dbRevealSource(sql);
  log('match logs → Postgres');
} else {
  const dataDir = resolve(env.DATA_DIR ?? 'data/matches');
  store = new JsonlStore(dataDir);
  log(`match logs → ${dataDir} (JSONL; set DATABASE_URL for Postgres and reopenable reveals)`);
}

const server = await startGameServer({
  clock,
  store,
  reveals,
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  agentWeights: weights,
  fillBotsAfterMs: fill,
  corsOrigin: env.CORS_ORIGIN,
  log,
});
if (fill !== null) log(`DEV bot fill after ${fill}ms`);

const stop = async () => {
  log('shutting down; running matches are marked aborted');
  await server.close();
  await sql?.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
