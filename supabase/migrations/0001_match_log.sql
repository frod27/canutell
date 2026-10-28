-- 0001_match_log.sql — CANUTELL match log (SPEC §Data schema). Phase 3.
-- Approved 2026-10-28 (docs/proposals/phase-3.md). Plain Postgres; runs unchanged on Supabase.
--
-- Three kinds of table:
--   reference  players, agent_versions, matches, seats
--   log        events, match_inputs, decision_timings, connections, rejections
--              append-only (CLAUDE.md invariant 8); UPDATE/DELETE only inside the privacy-deletion job
--   derived    decisions, stakes, messages, ballots, seat_results
--              rebuilt from the log by derive(match_id); never edited by hand
--
-- No personal data anywhere (CLAUDE.md invariant 9): players are pseudonymous ids, chat is stored masked.
-- Nothing here makes a row training-eligible; that needs trust >= T2 and consent (Phase 5).

create type match_mode   as enum ('full', 'quick');
create type reveal_mode  as enum ('individual', 'aggregate');
create type match_status as enum ('running', 'completed', 'aborted');
create type trust_level  as enum ('T0', 'T1', 'T2', 'T3');
create type seat_kind    as enum ('human', 'agent', 'filler');

-- ===== Reference tables =====

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
  created_at      timestamptz not null,           -- server clock
  ended_at        timestamptz,
  mode            match_mode not null,
  ruleset_version text not null,
  reveal_mode     reveal_mode not null,
  agent_count     smallint not null check (agent_count between 0 and 2),
  is_party        boolean not null,               -- CLAUDE.md invariant 11
  seed            text not null,
  status          match_status not null default 'running',
  flags           text[] not null default '{}',   -- phase2, phase3, scripted_agents, bot_fill, sped_up
  clock_speed     real not null default 1
);

create table seats (
  match_id             text not null references matches on delete cascade,
  seat_id              smallint not null check (seat_id between 0 and 5),
  kind                 seat_kind not null,
  player_id            text references players,           -- humans only
  agent_version        text references agent_versions,    -- agents only
  is_agent             boolean not null,
  trust_level_at_match trust_level,                       -- humans only
  primary key (match_id, seat_id),
  check (is_agent = (kind = 'agent')),
  check (is_agent = (agent_version is not null)),
  check ((kind = 'human') = (player_id is not null)),
  check ((kind = 'human') = (trust_level_at_match is not null))
);
create index seats_player on seats (player_id);

-- ===== Log tables (append-only) =====

create table events (
  event_id  bigint generated always as identity primary key,
  match_id  text not null references matches on delete cascade,
  seq       integer not null check (seq >= 0),
  type      text not null,
  seat_id   smallint check (seat_id between 0 and 5),
  payload   jsonb not null,
  server_ts timestamptz not null,
  unique (match_id, seq)
);
create index events_type on events (match_id, type);

-- replay(config, seed, inputs ordered by idx) must reproduce `events` exactly.
create table match_inputs (
  match_id text not null references matches on delete cascade,
  idx      integer not null check (idx >= 0),
  kind     text not null check (kind in ('advance', 'action')),
  action   jsonb,
  now_ms   bigint not null,
  primary key (match_id, idx),
  check ((kind = 'action') = (action is not null))
);

-- Server-measured latency per decision (CLAUDE.md invariant 6). client_sent_at is untrusted.
create table decision_timings (
  match_id       text not null references matches on delete cascade,
  seq            integer not null,               -- the decision event's seq
  seat_id        smallint not null check (seat_id between 0 and 5),
  kind           text not null,
  prompt_key     text not null,
  timed_out      boolean not null,
  prompt_sent_at timestamptz,                    -- null: the seat never saw the prompt
  received_at    timestamptz,
  latency_ms     integer check (latency_ms >= 0),
  client_sent_at bigint,
  primary key (match_id, seq)
);

create table connections (
  match_id text not null references matches on delete cascade,
  idx      integer not null,
  seat_id  smallint not null check (seat_id between 0 and 5),
  state    text not null check (state in ('connected', 'disconnected')),
  at       timestamptz not null,
  primary key (match_id, idx)
);

create table rejections (
  match_id    text not null references matches on delete cascade,
  idx         integer not null,
  seat_id     smallint not null check (seat_id between 0 and 5),
  at          timestamptz not null,
  code        text not null,
  engine_code text,
  action_type text not null,
  primary key (match_id, idx)
);

-- UPDATE/DELETE on log tables are refused, except inside the privacy-deletion job, which runs
-- `set local canutell.privacy_deletion = 'on'` in its own transaction. (TRUNCATE is not row-level;
-- it is revoked from everyone but the owner below.)
create function forbid_log_mutation() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('canutell.privacy_deletion', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'append-only table %: % is not allowed (CLAUDE.md invariant 8)', tg_table_name, tg_op;
end $$;

create trigger events_append_only before update or delete on events
  for each row execute function forbid_log_mutation();
create trigger match_inputs_append_only before update or delete on match_inputs
  for each row execute function forbid_log_mutation();
create trigger decision_timings_append_only before update or delete on decision_timings
  for each row execute function forbid_log_mutation();
create trigger connections_append_only before update or delete on connections
  for each row execute function forbid_log_mutation();
create trigger rejections_append_only before update or delete on rejections
  for each row execute function forbid_log_mutation();

-- ===== Derived tables (rebuilt from the log by derive(match_id)) =====

create table decisions (
  match_id    text not null references matches on delete cascade,
  seq         integer not null,                  -- decision_id = (match_id, seq)
  round       smallint not null,
  seat_id     smallint not null check (seat_id between 0 and 5),
  phase       text not null,
  kind        text not null check (kind in ('invest', 'stake', 'return', 'gamble', 'vote', 'ballot')),
  option_set  jsonb not null,
  chosen      jsonb not null,
  confidence  smallint,                          -- agents' decision confidence (Phase 4)
  timed_out   boolean not null,
  latency_ms  integer,
  prompt_seen boolean not null,                  -- false: timed out on a prompt never delivered
  state_hash  text not null,
  primary key (match_id, seq)
);
create index decisions_seat on decisions (match_id, seat_id, kind);

create table stakes (
  match_id         text not null references matches on delete cascade,
  stake_id         text not null,
  seq              integer not null,             -- seq of the stake_sent event (creation order)
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
  match_id  text not null references matches on delete cascade,
  seq       integer not null,                    -- message_id = (match_id, seq)
  round     smallint not null,
  phase     text not null,
  from_seat smallint not null,
  channel   text not null check (channel in ('table', 'dm', 'exile')),
  to_seat   smallint,
  text      text not null,                       -- already masked by the engine
  masked    boolean not null,
  sent_at   timestamptz not null,
  typing_ms integer,                             -- client-reported, untrusted
  pasted    boolean,                             -- client-reported, untrusted
  primary key (match_id, seq)
);

-- One row per (voter, target). Blank labels are explicit: label and confidence null, payoff 0.
create table ballots (
  match_id    text not null references matches on delete cascade,
  voter_seat  smallint not null,
  target_seat smallint not null,
  label       text check (label in ('agent', 'human')),
  confidence  smallint check (confidence between 50 and 100),
  payoff      smallint not null,
  applied     boolean not null,                  -- false for agent voters
  primary key (match_id, voter_seat, target_seat),
  check ((label is null) = (confidence is null))
);

create table seat_results (
  match_id            text not null references matches on delete cascade,
  seat_id             smallint not null,
  exiled_round        smallint,
  coins_before_reveal integer not null,
  delay_paid          integer not null,
  exile_bonus         integer not null,
  ballot_payoff       integer not null,
  final_score         integer not null,
  primary key (match_id, seat_id),
  check (final_score = coins_before_reveal + delay_paid + exile_bonus + ballot_payoff)
);

-- ===== Access =====
-- RLS on every table with no policies: Supabase's anon/authenticated roles see nothing through the
-- public API. The game server connects as the owner / a role that bypasses RLS.
alter table players          enable row level security;
alter table agent_versions   enable row level security;
alter table matches          enable row level security;
alter table seats            enable row level security;
alter table events           enable row level security;
alter table match_inputs     enable row level security;
alter table decision_timings enable row level security;
alter table connections      enable row level security;
alter table rejections       enable row level security;
alter table decisions        enable row level security;
alter table stakes           enable row level security;
alter table messages         enable row level security;
alter table ballots          enable row level security;
alter table seat_results     enable row level security;

revoke all on all tables in schema public from public;
do $$
declare r text;
begin
  -- Belt and braces on Supabase, where these roles exist and get default grants.
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
