-- 0007_studio_moderation.sql — pre-launch hardening. Approved 2026-11-03 (docs/proposals/hardening.md).
-- Operator moderation of Studio agents. Data affected: widens one check constraint; adds one table.
-- Nothing existing changes; no match, seat or training view is touched.

-- `suspended`: a moderator's hold. Unlike a strike pause, saving a new version does not lift it.
alter table studio_agents drop constraint studio_agents_status_check;
alter table studio_agents add constraint studio_agents_status_check
  check (status in ('active', 'paused', 'suspended', 'retired'));

-- Every moderator action, append-only. `moderator` is an operator's free-text name, never a player id.
create table studio_moderation (
  action_id bigint generated always as identity primary key,
  agent_id  bigint not null references studio_agents,
  action    text not null check (action in ('suspend', 'unsuspend', 'rename', 'retire')),
  reason    text not null check (length(reason) between 1 and 500),
  moderator text not null check (length(moderator) between 1 and 64),
  old_name  text,
  new_name  text,
  at        timestamptz not null default now()
);
create index studio_moderation_agent on studio_moderation (agent_id);
-- Names taken away by a rename stay unavailable to new agents.
create index studio_moderation_old_name on studio_moderation (lower(old_name)) where action = 'rename';
create trigger studio_moderation_append_only before update or delete on studio_moderation
  for each row execute function forbid_log_mutation();

alter table studio_moderation enable row level security;
revoke all on studio_moderation from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on studio_moderation from %I', r);
    end if;
  end loop;
end $$;
