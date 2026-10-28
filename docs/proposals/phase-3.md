# Phase 3 proposal: event log, schema, reveal screen

Status: **draft for approval.** Nothing here is applied or committed yet. CLAUDE.md requires approval of
the plan and of every schema change.

## Goal

Every match lands in Postgres as an append-only event log, together with the server's own records:

- inputs, so any match can be replayed
- server-measured timings
- connections
- rejections

The SPEC's analysis tables (`decisions`, `stakes`, `messages`, `ballots`, plus per-seat results) are
**derived** from that log by one deterministic function, and can be rebuilt at any time (CLAUDE.md
invariant 8). The reveal screen is built from the stored data, so a player can reopen it after the match.

## Plan

**1. Migration `supabase/migrations/0001_match_log.sql`** (full SQL below).

- Log tables are append-only, enforced by a database trigger. The only bypass is a session flag
  reserved for the privacy-deletion job.
- Derived tables are rebuilt per match.
- Row-level security is on for every table, with no policies. Supabase's public API keys therefore see
  nothing; only the game server's database role can read or write.

**2. `packages/db`** (new): a typed data-access layer on `pg`.

- `PostgresStore implements MatchStore`, the same interface the JSONL store uses, so the server swaps
  stores with one line.
- **Write path:** each engine transition's records (events, input, timings) go in one transaction,
  through an ordered per-match write queue. The database always holds the log up to the last
  completed transition. If a write fails, it retries with backoff, logs an alarm, and never reorders.
- **`derive(matchId)`:** reads events and timings, recomputes every derived row, and swaps them in one
  transaction. It runs at match end; `pnpm db:derive --all` rebuilds everything.
- **Migration runner:** applies the numbered files in `supabase/migrations/` in order and records each
  in `schema_migrations`. Supabase's own CLI can apply the same files.

**3. Server**

- `STORE=postgres|jsonl` with `DATABASE_URL`. JSONL stays as the no-database dev option.
- Startup recovery marks any `running` match `aborted`.
- `GET /api/matches/:id/reveal` with `Authorization: Bearer <guest token>`. Only a player who held a
  seat in that match gets an answer; everyone else gets 404. The response is built from derived tables.

**4. Reveal screen (`apps/web`)**

- One `Reveal` component, used both live and at `/match/[id]` for reopening.
- It covers everything SPEC §Reveal requires (roles and agent version, ballot accuracy, final scores,
  key moments), plus:
  - your ballot against the truth, label by label, with the payoff for each
  - each vote and who cast it (vote tallies stay hidden until Reveal, as decided in Phase 2)
  - your stakes and returns
  - the score breakdown

## Tests and acceptance

- **Migrations:** apply cleanly to an empty database. Test DB: a throwaway local Postgres 16 started
  by the test harness, or PGlite if none is available. The append-only trigger rejects any
  `UPDATE`/`DELETE` on log tables unless the privacy flag is set. The anonymous Supabase role reads
  nothing under RLS.
- **Derivation:**
  - golden tests on hand-built matches
  - `derive` is idempotent: running it twice gives identical rows
  - the reveal built from derived tables must equal the engine's own `viewFor(...).reveal` for every
    match (an independent cross-check of the derivation)
- **Store:**
  - `PostgresStore` round-trips a match exactly as `MemoryStore` does
  - replaying the stored inputs reproduces the stored events byte for byte
- **Acceptance:**
  - `pnpm loadtest --store postgres --matches 200 --mode both` must finish with 0 violations, plus:
    - every match's DB log equals its in-memory log
    - DB-derived reveal = engine reveal for every match
    - row counts reconcile (decisions = decision events, etc.)
  - the browser smoke run reopens `/match/[id]` after Reveal

## Proposed migration `0001_match_log.sql`

**What data it affects:** none exists yet, so this creates the store for all match data from now on.

- **Personal data:** none (CLAUDE.md invariant 9).
  - Players are only `p_<uuid>` ids.
  - Chat is stored already masked.
  - The raw-chat retention window is still an open SPEC question; nothing raw is stored, so it doesn't
    block this.
- **Training eligibility:** none. Nothing here makes a row eligible for training. Training needs
  trust T2+ and active consent, and those tables arrive in Phase 5.
- **Flags:** every match carries `flags`. Phase 2/3 matches have `phase2`/`phase3` and are excluded from
  research.

```sql
-- 0001_match_log.sql — CANUTELL match log (SPEC §Data schema). Phase 3.

create type match_mode   as enum ('full', 'quick');
create type reveal_mode  as enum ('individual', 'aggregate');
create type match_status as enum ('running', 'completed', 'aborted');
create type trust_level  as enum ('T0', 'T1', 'T2', 'T3');
create type seat_kind    as enum ('human', 'agent', 'filler');

-- Pseudonymous players. No personal data here, ever (invariant 9); identities come in Phase 5.
create table players (
  player_id       text primary key check (player_id ~ '^p_[0-9a-f-]{36}$'),
  created_at      timestamptz not null default now(),
  trust_level     trust_level not null default 'T0',
  research_opt_in boolean not null default false
);

create table agent_versions (
  agent_version  text primary key,
  class          text not null check (class in ('scripted', 'baseline', 'mimic')),
  decision_model text,
  chat_model     text,
  trained_on     jsonb,
  released_at    timestamptz
);
insert into agent_versions (agent_version, class, decision_model)
  values ('scripted-0', 'scripted', 'packages/bots policies');

create table matches (
  match_id        text primary key,
  created_at      timestamptz not null,          -- server clock
  ended_at        timestamptz,
  mode            match_mode not null,
  ruleset_version text not null,
  reveal_mode     reveal_mode not null,
  agent_count     smallint not null check (agent_count between 0 and 2),
  is_party        boolean not null,              -- invariant 11
  seed            text not null,
  status          match_status not null default 'running',
  flags           text[] not null default '{}',  -- phase2, phase3, scripted_agents, bot_fill, sped_up
  clock_speed     real not null default 1
);

create table seats (
  match_id             text not null references matches,
  seat_id              smallint not null check (seat_id between 0 and 5),
  kind                 seat_kind not null,
  player_id            text references players,          -- humans only
  agent_version        text references agent_versions,   -- agents only
  is_agent             boolean not null,
  trust_level_at_match trust_level,                      -- humans only
  primary key (match_id, seat_id),
  check (is_agent = (kind = 'agent')),
  check (is_agent = (agent_version is not null)),
  check ((kind = 'human') = (player_id is not null))
);

-- ===== Append-only log tables (invariant 8) =====

create table events (
  event_id  bigint generated always as identity primary key,
  match_id  text not null references matches,
  seq       integer not null check (seq >= 0),
  type      text not null,
  seat_id   smallint check (seat_id between 0 and 5),
  payload   jsonb not null,
  server_ts timestamptz not null,
  unique (match_id, seq)
);
create index events_type on events (match_id, type);

-- Everything needed to replay a match: replay(config, seed, inputs) must reproduce `events`.
create table match_inputs (
  match_id text not null references matches,
  idx      integer not null check (idx >= 0),
  kind     text not null check (kind in ('advance', 'action')),
  action   jsonb,
  now_ms   bigint not null,
  primary key (match_id, idx),
  check ((kind = 'action') = (action is not null))
);

-- Server-measured latency per decision (invariant 6). client_sent_at is untrusted, stored for comparison.
create table decision_timings (
  match_id       text not null references matches,
  seq            integer not null,          -- the decision event's seq
  seat_id        smallint not null,
  kind           text not null,
  prompt_key     text not null,
  timed_out      boolean not null,
  prompt_sent_at timestamptz,               -- null: the seat never saw the prompt
  received_at    timestamptz,
  latency_ms     integer check (latency_ms >= 0),
  client_sent_at bigint,
  primary key (match_id, seq)
);

create table connections (
  match_id text not null references matches,
  idx      integer not null,
  seat_id  smallint not null,
  state    text not null check (state in ('connected', 'disconnected')),
  at       timestamptz not null,
  primary key (match_id, idx)
);

create table rejections (
  match_id    text not null references matches,
  idx         integer not null,
  seat_id     smallint not null,
  at          timestamptz not null,
  code        text not null,
  engine_code text,
  action_type text not null,
  primary key (match_id, idx)
);

-- Log tables reject UPDATE and DELETE, except inside the privacy-deletion job, which sets
-- `set local canutell.privacy_deletion = 'on'` in its own transaction.
create function forbid_log_mutation() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('canutell.privacy_deletion', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'append-only table %: % is not allowed', tg_table_name, tg_op;
end $$;
-- (one BEFORE UPDATE OR DELETE trigger per log table: events, match_inputs, decision_timings,
--  connections, rejections)

-- ===== Derived tables: rebuilt from the log by derive(match_id); never edited by hand =====

create table decisions (
  match_id    text not null references matches,
  seq         integer not null,             -- decision_id = (match_id, seq)
  round       smallint not null,
  seat_id     smallint not null,
  phase       text not null,
  kind        text not null,                -- invest, stake, return, gamble, vote, ballot
  option_set  jsonb not null,
  chosen      jsonb not null,
  confidence  smallint,                     -- agents' decision confidence (Phase 4)
  timed_out   boolean not null,
  latency_ms  integer,
  prompt_seen boolean not null,             -- false: timed out on a prompt never delivered
  state_hash  text not null,
  primary key (match_id, seq)
);

create table stakes (
  match_id         text not null references matches,
  stake_id         text not null,
  round            smallint not null,
  from_seat        smallint not null,
  to_seat          smallint not null,
  sent             smallint not null,
  received         smallint not null,
  returned         smallint,
  return_timed_out boolean,
  primary key (match_id, stake_id)
);

create table messages (
  match_id  text not null references matches,
  seq       integer not null,               -- message_id = (match_id, seq)
  round     smallint not null,
  phase     text not null,
  from_seat smallint not null,
  channel   text not null check (channel in ('table', 'dm', 'exile')),
  to_seat   smallint,
  text      text not null,                  -- already masked by the engine
  masked    boolean not null,
  sent_at   timestamptz not null,
  typing_ms integer,                        -- client-reported, untrusted
  pasted    boolean,                        -- client-reported, untrusted
  primary key (match_id, seq)
);

-- One row per (voter, target); blank labels are stored explicitly (label null, payoff 0).
create table ballots (
  match_id    text not null references matches,
  voter_seat  smallint not null,
  target_seat smallint not null,
  label       text check (label in ('agent', 'human')),
  confidence  smallint check (confidence between 50 and 100),
  payoff      smallint not null,
  applied     boolean not null,             -- false for agent voters
  primary key (match_id, voter_seat, target_seat),
  check ((label is null) = (confidence is null))
);

create table seat_results (
  match_id            text not null references matches,
  seat_id             smallint not null,
  exiled_round        smallint,
  coins_before_reveal integer not null,
  delay_paid          integer not null,
  exile_bonus         integer not null,
  ballot_payoff       integer not null,
  final_score         integer not null,
  primary key (match_id, seat_id)
);

-- RLS on everything, no policies: Supabase anon/authenticated roles see nothing.
-- The game server connects with a role that bypasses RLS.
alter table players          enable row level security;
-- … likewise for every table above.

create table schema_migrations (version text primary key, applied_at timestamptz not null default now());
```

## Open questions (decisions needed)

1. **Guest data retention.**
   - **The conflict:** SPEC §Integrity says T0 guests are "play only; nothing kept beyond the match".
     Until Phase 5 adds accounts, _every_ player is a guest, so a literal reading means storing
     nothing, which leaves Phase 3 nothing to test.
   - **Recommendation:** keep pre-Phase-5 matches as flagged dev data (`phase3` flag, never
     research-eligible), and purge them before the closed alpha.
   - **Alternative:** enforce the T0 rule now, with a privacy job that deletes a guest's rows when the
     match ends.
2. **Schema scope.**
   - **Recommendation:** match tables plus a minimal `players` table now. `identities`, `consents` and
     `integrity_signals` come in Phase 5's migration, designed alongside the consent flow.
   - **Alternative:** create every SPEC table now, even though most would sit empty.
3. **Reveal screen.**
   - **Recommendation:** live, plus reopenable at `/match/[id]` from the database.
   - **Alternative:** polish the live screen only, with no server HTTP API.
4. **Database target.**
   - **Recommendation:** build against standard Postgres, which is what Supabase runs, test locally, and
     connect with `DATABASE_URL`.
   - **Your input needed:** do you have a Supabase project the server should use? I can't create one
     from here; if you don't have one yet, everything runs locally until you do.
