import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { advancePhase, applyAction, createMatch, replay, type MatchState } from '@canutell/engine';
import { decisionPromptKey, type MatchEvent, type TrustLevel } from '@canutell/protocol';
import { runMatch, type SimMatchResult } from '@canutell/sim';
import {
  migrate,
  pgSql,
  pgliteSql,
  type MatchMeta,
  type MatchStore,
  type Sql,
  type TimingRecord,
} from '../src';

/**
 * A fresh, migrated database per call. Real Postgres when TEST_DATABASE_URL is set (a throwaway
 * database is created and dropped), otherwise in-process PGlite.
 */
export async function freshDb(): Promise<{
  sql: Sql;
  kind: 'postgres' | 'pglite';
  done: () => Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const admin = pgSql(url, { max: 1 });
    const name = `canutell_test_${randomBytes(6).toString('hex')}`;
    await admin.exec(`create database ${name}`);
    await admin.exec(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        exception when duplicate_object or unique_violation then null; end $$`,
    );
    const u = new URL(url);
    u.pathname = `/${name}`;
    const sql = pgSql(u.toString());
    await migrate(sql);
    return {
      sql,
      kind: 'postgres',
      done: async () => {
        await sql.close();
        await admin.exec(`drop database ${name}`);
        await admin.close();
      },
    };
  }
  const db = new PGlite();
  await db.exec('create role anon nologin');
  const sql = pgliteSql(db);
  await migrate(sql);
  return { sql, kind: 'pglite', done: () => sql.close() };
}

const hex = (n: number, len: number) => n.toString(16).padStart(len, '0');
export const playerIdFor = (match: number, seat: number) =>
  `p_00000000-0000-4000-8000-${hex(match, 8)}${hex(seat, 4)}`;

/**
 * A seeded simulated match, with agent seats relabelled to the seeded `scripted-0` version (the sim's own
 * label is not in agent_versions). Bots never see roles, so the same inputs replay to a consistent log.
 */
export function simMatch(index: number, mode: 'full' | 'quick' = 'quick'): SimMatchResult {
  const r = runMatch({
    baseSeed: 'db-test',
    index,
    mode,
    timeoutPct: 8,
    agentWeights: [1, 1, 1],
    collectViews: false,
  });
  const config = {
    ...r.config,
    seats: r.config.seats.map((s) => ({ ...s, agentVersion: s.isAgent ? 'scripted-0' : null })),
  };
  const again = replay(config, r.seed, r.inputs);
  return { ...r, config, events: again.events, state: again.state };
}

export function metaFor(
  r: SimMatchResult,
  index: number,
  flags: MatchMeta['flags'] = ['phase3'],
  trustLevel: TrustLevel = 'T0',
): MatchMeta {
  return {
    matchId: r.config.matchId,
    mode: r.config.mode,
    seed: r.seed,
    isParty: r.config.isParty,
    config: r.config,
    occupants: r.config.seats.map((s) => ({
      seat: s.seatId,
      kind: s.isAgent ? ('agent' as const) : ('human' as const),
      playerId: s.isAgent ? `b_${index}_${s.seatId}` : playerIdFor(index, s.seatId),
      ...(s.isAgent ? {} : { trustLevel }),
    })),
    flags,
    createdAt: 1_700_000_000_000,
    clockSpeed: 1,
    status: 'running',
    endedAt: null,
  };
}

/** A plausible server timing record for a decision event (prompt shown at phase start). */
export function timingFor(e: Extract<MatchEvent, { type: 'decision' }>): TimingRecord {
  const p = e.payload;
  return {
    seq: e.seq,
    seat: e.seat!,
    kind: p.kind,
    promptKey: decisionPromptKey(p),
    timedOut: p.timedOut,
    promptSentAt: p.phaseStartedAt,
    receivedAt: p.timedOut ? null : p.decidedAt,
    latencyMs: p.timedOut ? null : p.decidedAt - p.phaseStartedAt,
    clientSentAt: p.timedOut ? null : p.decidedAt - 40,
  };
}

/**
 * Feed a simulated match into a store transition by transition, exactly as the match runner does:
 * open, then for each input its events and timings in the same tick, yielding between transitions (in the
 * server each transition is its own timer callback or socket message). Returns the final engine state.
 */
export async function feed(
  store: MatchStore,
  r: SimMatchResult,
  meta: MatchMeta,
  opts: { close?: boolean; upTo?: number; env?: boolean } = {},
): Promise<MatchState> {
  store.open(meta);
  // A web client reports its environment once; scripted sim seats otherwise send no client signals.
  if (opts.env)
    for (const o of meta.occupants)
      if (o.kind === 'human' && (o.trustLevel ?? 'T0') !== 'T0')
        store.clientSignal(meta.matchId, {
          seat: o.seat,
          at: meta.createdAt,
          kind: 'env',
          value: {
            webdriver: false,
            headlessUserAgent: false,
            noLanguages: false,
            zeroOuterSize: false,
            serverHeadlessUa: false,
          },
        });
  let state = createMatch(r.config, r.seed).state;
  const inputs = r.inputs.slice(0, opts.upTo ?? r.inputs.length);
  for (const input of inputs) {
    const t =
      input.kind === 'advance' ? advancePhase(state, input.now) : applyAction(state, input.action, input.now);
    state = t.state;
    store.input(meta.matchId, input);
    store.events(meta.matchId, t.events);
    for (const e of t.events) if (e.type === 'decision') store.timing(meta.matchId, timingFor(e));
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (opts.close ?? true)
    store.close(meta.matchId, state.phase === 'reveal' ? 'completed' : 'aborted', state.clock ?? 0);
  return state;
}

/**
 * Make `playerId` an account holder directly in the database (no WebAuthn): identity row, trust level, terms
 * consent, and optionally research consent. For tests only.
 */
export async function makeAccount(
  sql: Sql,
  playerId: string,
  opts: { trust: TrustLevel; research: boolean; ageConfirmed?: boolean | null },
): Promise<void> {
  await sql.query('insert into players (player_id) values ($1) on conflict (player_id) do nothing', [
    playerId,
  ]);
  await sql.query('update players set trust_level = $2 where player_id = $1', [playerId, opts.trust]);
  const age = opts.ageConfirmed === undefined ? opts.trust >= 'T2' : opts.ageConfirmed;
  await sql.query(
    `insert into identity.identities (player_id, user_handle, verification_method, verified_at, age_confirmed,
       age_method, age_answered_at)
     values ($1, $2, 'passkey', now(), $3, $4, $5)`,
    [playerId, randomBytes(32), age, age === null ? null : 'self_attested', age === null ? null : new Date()],
  );
  await sql.query(
    `insert into consents (player_id, consent_type, version, granted_at) values ($1, 'terms', 1, now())`,
    [playerId],
  );
  if (opts.research)
    await sql.query(
      `insert into consents (player_id, consent_type, version, granted_at) values ($1, 'research', 1, now())`,
      [playerId],
    );
}
