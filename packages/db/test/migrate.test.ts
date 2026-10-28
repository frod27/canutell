import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, type Sql } from '../src';
import { freshDb } from './helpers';

// CLAUDE.md "Every change is a numbered migration"; invariant 8 (append-only log); Supabase exposure.

let sql: Sql;
let done: () => Promise<void>;
beforeAll(async () => {
  ({ sql, done } = await freshDb());
});
afterAll(() => done());

const LOG_TABLES = ['events', 'match_inputs', 'decision_timings', 'connections', 'rejections'];

async function seedMatch(id = 'm-1') {
  await sql.query(
    `insert into matches (match_id, created_at, mode, ruleset_version, reveal_mode, agent_count, is_party, seed, flags)
     values ($1, now(), 'quick', 'v0.2', 'aggregate', 1, false, 's', '{phase3}')`,
    [id],
  );
  await sql.query(
    `insert into events (match_id, seq, type, seat_id, payload, server_ts) values ($1, 0, 'match_created', null, '{}', now())`,
    [id],
  );
  await sql.query(
    `insert into match_inputs (match_id, idx, kind, action, now_ms) values ($1, 0, 'advance', null, 1)`,
    [id],
  );
  await sql.query(
    `insert into decision_timings (match_id, seq, seat_id, kind, prompt_key, timed_out) values ($1, 1, 0, 'invest', 'invest:1', true)`,
    [id],
  );
  await sql.query(
    `insert into connections (match_id, idx, seat_id, state, at) values ($1, 0, 0, 'connected', now())`,
    [id],
  );
  await sql.query(
    `insert into rejections (match_id, idx, seat_id, at, code, action_type) values ($1, 0, 0, now(), 'late', 'invest')`,
    [id],
  );
}

describe('migrations', () => {
  it('apply in order, are recorded, and are idempotent', async () => {
    const versions = (
      await sql.query<{ version: string }>('select version from schema_migrations order by version')
    ).map((r) => r.version);
    expect(versions).toEqual(loadMigrations().map((m) => m.version));
    expect(await migrate(sql)).toEqual([]);
  });

  it('migration files are numbered NNNN_name.sql with no gaps', () => {
    const vs = loadMigrations().map((m) => Number(m.version));
    vs.forEach((v, i) => expect(v).toBe(i + 1));
  });

  it('seeds the scripted-0 agent version', async () => {
    const rows = await sql.query('select agent_version, class from agent_versions');
    expect(rows).toContainEqual({ agent_version: 'scripted-0', class: 'scripted' });
  });
});

describe('append-only log — CLAUDE.md invariant 8', () => {
  beforeAll(() => seedMatch());

  it.each(LOG_TABLES)('%s refuses UPDATE and DELETE', async (table) => {
    await expect(sql.query(`delete from ${table} where match_id = 'm-1'`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`update ${table} set match_id = match_id where match_id = 'm-1'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('deleting a match cannot cascade into its log', async () => {
    await expect(sql.query(`delete from matches where match_id = 'm-1'`)).rejects.toThrow(/append-only/);
  });

  it('the privacy-deletion flag (set local, in its own transaction) is the only way through', async () => {
    await seedMatch('m-2');
    await sql.transaction(async (tx) => {
      await tx.exec(`set local canutell.privacy_deletion = 'on'`);
      await tx.query(`delete from matches where match_id = 'm-2'`);
    });
    for (const t of LOG_TABLES) {
      expect(await sql.query(`select 1 from ${t} where match_id = 'm-2'`)).toEqual([]);
    }
    // `set local` ended with the transaction: the guard is back.
    await expect(sql.query(`delete from events where match_id = 'm-1'`)).rejects.toThrow(/append-only/);
  });
});

describe('constraints', () => {
  it('rejects non-pseudonymous player ids (CLAUDE.md invariant 9)', async () => {
    await expect(sql.query(`insert into players (player_id) values ('alice@example.com')`)).rejects.toThrow();
    await sql.query(`insert into players (player_id) values ('p_00000000-0000-4000-8000-000000000001')`);
  });

  it('seats: agents have a version and no player; humans have a player and a trust level', async () => {
    await expect(
      sql.query(`insert into seats (match_id, seat_id, kind, is_agent) values ('m-1', 0, 'agent', true)`),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `insert into seats (match_id, seat_id, kind, is_agent, trust_level_at_match) values ('m-1', 1, 'human', false, 'T0')`,
      ),
    ).rejects.toThrow();
    await sql.query(
      `insert into seats (match_id, seat_id, kind, player_id, is_agent, trust_level_at_match)
       values ('m-1', 1, 'human', 'p_00000000-0000-4000-8000-000000000001', false, 'T0')`,
    );
    await sql.query(
      `insert into seats (match_id, seat_id, kind, agent_version, is_agent) values ('m-1', 2, 'agent', 'scripted-0', true)`,
    );
  });

  it('seat_results must add up', async () => {
    await expect(
      sql.query(`insert into seat_results values ('m-1', 0, null, 100, 0, 0, 20, 999)`),
    ).rejects.toThrow();
  });
});

describe('Supabase exposure', () => {
  it('row-level security hides every table from the anon role, even with a table grant', async () => {
    await sql.exec('grant select on events, matches, players, decisions to anon');
    const tables = await sql.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public'`,
    );
    for (const t of tables) expect([t.tablename, t.rowsecurity]).toEqual([t.tablename, true]);
    const seen = await sql.transaction(async (tx) => {
      await tx.exec('set local role anon');
      return tx.query('select * from events');
    });
    expect(seen).toEqual([]);
    expect((await sql.query('select count(*)::int as n from events'))[0]).toMatchObject({
      n: expect.any(Number),
    });
  });
});
