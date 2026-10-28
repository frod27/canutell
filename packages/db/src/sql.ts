import pg from 'pg';

// The smallest database surface the rest of the package needs: parameterized queries and transactions.
// Two backends: node-postgres for real Postgres (local, Supabase) and PGlite (in-process WASM Postgres)
// for tests and database-less dev.

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run multiple statements (no parameters), e.g. a migration file. */
  exec(text: string): Promise<void>;
  /** Run `fn` in one transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Postgres types: bigint (int8) as JS number. Every bigint we store (ms timestamps, event ids) is far
// below 2^53, and exact integers matter more here than arbitrary precision.
pg.types.setTypeParser(20, (v) => Number(v));

function fromClient(client: pg.PoolClient | pg.Client): Omit<Sql, 'transaction' | 'close'> {
  return {
    async query<T>(text: string, params?: readonly unknown[]) {
      const r = await client.query(text, params as unknown[] | undefined);
      return r.rows as T[];
    },
    async exec(text: string) {
      await client.query(text);
    },
  };
}

/** node-postgres pool. `url` is a standard connection string (DATABASE_URL). */
export function pgSql(url: string, opts: { max?: number } = {}): Sql {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const base = {
    async query<T>(text: string, params?: readonly unknown[]) {
      const r = await pool.query(text, params as unknown[] | undefined);
      return r.rows as T[];
    },
    async exec(text: string) {
      await pool.query(text);
    },
  };
  return {
    ...base,
    async transaction<T>(fn: (tx: Sql) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx: Sql = {
          ...fromClient(client),
          transaction: (inner) => inner(tx), // flat: nested calls join the outer transaction
          close: async () => {},
        };
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Minimal structural type for a PGlite instance (avoids a hard dependency outside tests). */
export interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(
    fn: (tx: {
      query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
      exec(text: string): Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

/**
 * PGlite backend. PGlite runs one statement at a time, so this adapter serializes calls; transactions
 * hold the queue for their duration.
 */
export function pgliteSql(db: PGliteLike): Sql {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const wrap = (q: Pick<PGliteLike, 'query' | 'exec'>, nested: boolean): Sql => {
    const self: Sql = {
      query: <T>(text: string, params?: readonly unknown[]) => {
        const go = async () => normalizeRows((await q.query<T>(text, params as unknown[] | undefined)).rows);
        return nested ? go() : serial(go);
      },
      exec: (text: string) => {
        const go = async () => {
          await q.exec(text);
        };
        return nested ? go() : serial(go);
      },
      transaction: <T>(fn: (tx: Sql) => Promise<T>) =>
        nested ? fn(self) : serial(() => db.transaction((tx) => fn(wrap(tx, true)))),
      close: () => (nested ? Promise.resolve() : serial(() => db.close())),
    };
    return self;
  };
  return wrap(db, false);
}

/** PGlite returns bigint columns as JS bigint; match the pg backend (numbers). */
function normalizeRows<T>(rows: T[]): T[] {
  for (const row of rows as Record<string, unknown>[]) {
    for (const k of Object.keys(row)) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  }
  return rows;
}
