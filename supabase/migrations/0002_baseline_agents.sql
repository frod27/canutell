-- 0002_baseline_agents.sql — Phase 4. Approved 2026-10-28 (docs/proposals/phase-4.md).
-- Adds the baseline-1 agent version and an append-only table for agent-reported decision confidence.
-- No existing or human data is touched. Agent seats never enter the training pool (CLAUDE.md invariant 10).

insert into agent_versions (agent_version, class, decision_model, chat_model, released_at)
  values ('baseline-1', 'baseline', 'softmax policy over view features, v1', 'claude-opus-5-5 by default (AGENT_CHAT_MODEL); scripted lines when no API credential', now());

-- Agent-reported confidence per decision (SPEC §Agents: "picks from the phase's option set, with a confidence").
create table agent_annotations (
  match_id   text not null references matches on delete cascade,
  seq        integer not null,                                     -- the decision event's seq
  seat_id    smallint not null check (seat_id between 0 and 5),
  confidence smallint not null check (confidence between 0 and 100), -- percent, as decisions.confidence
  primary key (match_id, seq)
);
create trigger agent_annotations_append_only before update or delete on agent_annotations
  for each row execute function forbid_log_mutation();
alter table agent_annotations enable row level security;
revoke all on agent_annotations from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on agent_annotations from %I', r);
    end if;
  end loop;
end $$;
