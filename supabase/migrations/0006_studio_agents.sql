-- 0006_studio_agents.sql — Phase 7. Approved 2026-11-03 (docs/proposals/phase-7.md). Player-made (Studio) agents.
-- Data affected: widens two check constraints; adds tables and nullable columns. Nothing existing changes.

alter table agent_versions drop constraint agent_versions_class_check;
alter table agent_versions add constraint agent_versions_class_check
  check (class in ('scripted', 'baseline', 'mimic', 'studio'));

create table studio_agents (
  agent_id   bigint generated always as identity primary key,
  owner_id   text not null references players,
  name       text not null check (length(name) between 3 and 24),
  status     text not null default 'active' check (status in ('active', 'paused', 'retired')),
  created_at timestamptz not null default now(),
  paused_reason text
);
create unique index studio_agents_name on studio_agents (lower(name));
create index studio_agents_owner on studio_agents (owner_id);

alter table agent_versions add column studio_agent_id bigint references studio_agents;
alter table agent_versions add column config jsonb;   -- Studio: sliders + style text (masked, ≤ 300 chars)
alter table agent_versions add constraint agent_versions_studio
  check ((class = 'studio') = (studio_agent_id is not null and config is not null));

-- A Studio version is immutable once created: a change is a new version.
create function studio_version_guard() returns trigger language plpgsql as $$
begin
  if old.class = 'studio' then
    raise exception 'studio agent versions are immutable; save a new version';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger agent_versions_studio_immutable before update or delete on agent_versions
  for each row execute function studio_version_guard();

-- Safety-filter blocks per version (append-only).
create table studio_strikes (
  strike_id     bigint generated always as identity primary key,
  agent_version text not null references agent_versions,
  match_id      text not null references matches on delete cascade,
  reason        text not null,        -- the filter's category, never the blocked text
  at            timestamptz not null default now()
);
create trigger studio_strikes_append_only before update or delete on studio_strikes
  for each row execute function forbid_log_mutation();

-- Studio terms are a consent like the others.
alter table consents drop constraint consents_consent_type_check;
alter table consents add constraint consents_consent_type_check
  check (consent_type in ('terms', 'research', 'studio'));

alter table studio_agents  enable row level security;
alter table studio_strikes enable row level security;
revoke all on studio_agents, studio_strikes from public;
do $$
declare r text;
begin
  -- Belt and braces on Supabase, where these roles exist and get default grants.
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on studio_agents, studio_strikes from %I', r);
    end if;
  end loop;
end $$;

-- A maker's own seat in a match where their Studio agent also sat is never training data: they know one
-- seat's role (SPEC §Agents, Studio). Computed from the seats themselves, not from a flag. Same columns,
-- so training_decisions and the export grant carry over. (Added while implementing the approved rule;
-- DECISIONS "Differences between migration 0006 and the proposal".)
create or replace view training_seats as
  select s.match_id, s.seat_id, s.player_id
    from seats s
    join players p on p.player_id = s.player_id
    join matches m on m.match_id = s.match_id
    join active_research_consent c on c.player_id = s.player_id
   where s.kind = 'human' and not s.is_agent
     and s.trust_level_at_match >= 'T2' and p.trust_level >= 'T2' and p.deleted_at is null
     and m.status = 'completed'
     and not (m.flags && array['phase2', 'phase3', 'phase4', 'phase5', 'bot_fill', 'sped_up'])
     and not exists (
       select 1 from integrity_signals i
         left join seat_review_status r on r.match_id = i.match_id and r.seat_id = i.seat_id
        where i.match_id = s.match_id and i.seat_id = s.seat_id and i.flagged
          and r.decision is distinct from 'cleared')
     and not exists (
       select 1 from seats a
         join agent_versions v on v.agent_version = a.agent_version
         join studio_agents sa on sa.agent_id = v.studio_agent_id
        where a.match_id = s.match_id and sa.owner_id = s.player_id);
