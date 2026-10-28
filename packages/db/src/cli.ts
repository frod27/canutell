import { parseArgs } from 'node:util';
import { migrate, loadMigrations } from './migrate';
import { purgeMatchesWithFlag, rebuildAllDerived, rebuildDerived } from './queries';
import { pgSql } from './sql';

// pnpm db:migrate                      apply pending migrations
// pnpm db:status                       list applied / pending migrations
// pnpm db:derive [--match ID]          rebuild derived tables (all matches, or one)
// pnpm db:purge --flag phase3 --yes    privacy deletion of every match carrying the flag
// All commands use DATABASE_URL.

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: rest,
    options: {
      match: { type: 'string' },
      flag: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const sql = pgSql(url, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(sql);
        console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date');
        return 0;
      }
      case 'status': {
        const done = new Set(
          (await sql.query<{ version: string }>('select version from schema_migrations').catch(() => [])).map(
            (r) => r.version,
          ),
        );
        for (const m of loadMigrations())
          console.log(`${done.has(m.version) ? 'applied' : 'PENDING'}  ${m.name}`);
        return 0;
      }
      case 'derive': {
        if (values.match) {
          const rows = await rebuildDerived(sql, values.match);
          console.log(
            `${values.match}: ${rows.decisions.length} decisions, ${rows.stakes.length} stakes, ${rows.messages.length} messages`,
          );
        } else {
          let failed = 0;
          const n = await rebuildAllDerived(sql, (id, e) => {
            failed++;
            console.error(`${id}: ${String(e)}`);
          });
          console.log(`rebuilt ${n} match(es)${failed ? `, ${failed} FAILED` : ''}`);
          return failed ? 1 : 0;
        }
        return 0;
      }
      case 'purge': {
        if (!values.flag) throw new Error('--flag is required');
        if (!values.yes) {
          console.error(`this permanently deletes every match flagged "${values.flag}"; re-run with --yes`);
          return 2;
        }
        const out = await purgeMatchesWithFlag(sql, values.flag);
        console.log(`purged ${out.matches} match(es) and ${out.players} orphaned player(s)`);
        return 0;
      }
      default:
        console.error('usage: db <migrate|status|derive|purge> [--match ID] [--flag F --yes]');
        return 2;
    }
  } finally {
    await sql.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
