-- 0004_alpha.sql — Phase 6. Approved 2026-10-29 (docs/proposals/phase-6.md). Invite codes, the invite each account used, and the post-match survey.
-- Data affected: adds tables and one nullable column; nothing existing changes.

create table identity.invites (
  invite_id   bigint generated always as identity primary key,
  code_hash   bytea not null unique check (length(code_hash) = 32),   -- sha256; the code is never stored
  label       text not null,                                           -- operator's note, never a player's name
  max_uses    integer not null check (max_uses between 1 and 1000),
  uses        integer not null default 0 check (uses >= 0 and uses <= max_uses),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);
alter table identity.identities add column invite_id bigint references identity.invites;

create table match_feedback (
  match_id     text not null references matches on delete cascade,
  seat_id      smallint not null check (seat_id between 0 and 5),
  fun          smallint not null check (fun between 1 and 5),
  tags         text[] not null default '{}'
                 check (tags <@ array['too_long','too_slow','confusing','great_chat','felt_unfair','bugs']),
  comment      text check (length(comment) <= 500),                    -- masked like chat
  submitted_at timestamptz not null,
  primary key (match_id, seat_id)
);
create trigger match_feedback_append_only before update or delete on match_feedback
  for each row execute function forbid_log_mutation();

alter table identity.invites enable row level security;
alter table match_feedback  enable row level security;
revoke all on identity.invites from public;
revoke all on match_feedback from public;
do $$
declare r text;
begin
  -- Belt and braces on Supabase, where these roles exist and get default grants.
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on identity.invites from %I', r);
      execute format('revoke all on match_feedback from %I', r);
    end if;
  end loop;
end $$;
