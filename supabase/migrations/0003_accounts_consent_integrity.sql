-- 0003_accounts_consent_integrity.sql — Phase 5. Approved 2026-10-29 (docs/proposals/phase-5.md).
-- Accounts (passkeys), consents, trust history, integrity signals and the training-pool views.
-- Data affected: drops players.research_opt_in (false for every row today); adds players.deleted_at.
-- Nothing else existing changes.

alter table players drop column research_opt_in;      -- consents is the source of truth (view below)
alter table players add column deleted_at timestamptz;

-- ===== Identity (locked; never joined into training exports, CLAUDE.md invariant 9) =====
create schema identity;
revoke all on schema identity from public;

create table identity.identities (
  player_id           text primary key references public.players,
  user_handle         bytea not null unique check (length(user_handle) = 32), -- WebAuthn user.id, random
  email_hash          bytea,                         -- SPEC column; not collected in Phase 5
  verification_method text not null check (verification_method in ('passkey', 'phone')),
  verified_at         timestamptz not null,
  age_confirmed       boolean,                       -- null: not answered; false: under 18
  age_method          text check (age_method in ('self_attested')),
  age_answered_at     timestamptz,
  check ((age_confirmed is null) = (age_method is null)),
  check ((age_confirmed is null) = (age_answered_at is null))
);
create table identity.passkeys (
  credential_id text primary key,                    -- base64url
  player_id     text not null references identity.identities on delete cascade,
  public_key    bytea not null,
  sign_count    bigint not null default 0,
  transports    text[] not null default '{}',
  multi_device  boolean not null,
  backed_up     boolean not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create table identity.sessions (
  token_hash bytea primary key check (length(token_hash) = 32), -- sha256; the token is never stored
  player_id  text not null references identity.identities on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_player on identity.sessions (player_id);

-- ===== Consents (SPEC §Data schema) =====
create table consents (
  consent_id   bigint generated always as identity primary key,
  player_id    text not null references players,
  consent_type text not null check (consent_type in ('terms', 'research')),
  version      integer not null check (version >= 1),
  granted_at   timestamptz not null,
  revoked_at   timestamptz,
  check (revoked_at is null or revoked_at >= granted_at)
);
create unique index consents_one_active on consents (player_id, consent_type) where revoked_at is null;
-- A grant can only be revoked, once. Nothing else may change, except in the privacy-deletion job.
create function consents_guard() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('canutell.privacy_deletion', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null
     and (new.consent_id, new.player_id, new.consent_type, new.version, new.granted_at)
       = (old.consent_id, old.player_id, old.consent_type, old.version, old.granted_at) then
    return new;
  end if;
  raise exception 'consents: % is not allowed (only revocation)', tg_op;
end $$;
create trigger consents_guarded before update or delete on consents
  for each row execute function consents_guard();

-- ===== Trust history (append-only) =====
create table trust_changes (
  change_id  bigint generated always as identity primary key,
  player_id  text not null references players,
  from_level trust_level not null,
  to_level   trust_level not null,
  reason     text not null check (reason in ('account_created', 'age_confirmed', 'clean_matches',
               'automation_flag', 'review_cleared', 'review_confirmed', 'reviewer_restored',
               'account_deleted')),
  match_id   text references matches,
  at         timestamptz not null default now()
);
create trigger trust_changes_append_only before update or delete on trust_changes
  for each row execute function forbid_log_mutation();

-- ===== Integrity =====
-- Log: client-reported signals with server timestamps. Account holders' seats only (guests: nothing kept).
create table client_signals (
  match_id text not null references matches on delete cascade,
  idx      integer not null,
  seat_id  smallint not null check (seat_id between 0 and 5),
  at       timestamptz not null,
  kind     text not null check (kind in ('env', 'focus', 'blur')),
  value    jsonb,                                   -- env: booleans only; no raw fingerprint, no user agent
  primary key (match_id, idx)
);
create trigger client_signals_append_only before update or delete on client_signals
  for each row execute function forbid_log_mutation();

-- Derived (rebuilt from the log at match end, like decisions).
create table integrity_signals (
  match_id text not null references matches on delete cascade,
  seat_id  smallint not null check (seat_id between 0 and 5),
  signal   text not null,
  value    real not null,
  flagged  boolean not null,
  primary key (match_id, seat_id, signal)
);

-- Human review of flagged seats (append-only; the latest decision wins).
create table integrity_reviews (
  review_id  bigint generated always as identity primary key,
  match_id   text not null references matches on delete cascade,
  seat_id    smallint not null check (seat_id between 0 and 5),
  decision   text not null check (decision in ('cleared', 'confirmed')),
  reviewer   text not null,                          -- operator handle, never a player id
  note       text,
  decided_at timestamptz not null default now()
);
create trigger integrity_reviews_append_only before update or delete on integrity_reviews
  for each row execute function forbid_log_mutation();

-- ===== Training pool (CLAUDE.md invariant 10) =====
create view active_research_consent as
  select player_id, version, granted_at from consents
   where consent_type = 'research' and revoked_at is null and version >= 1; -- required version

create view seat_review_status as
  select distinct on (match_id, seat_id) match_id, seat_id, decision
    from integrity_reviews order by match_id, seat_id, decided_at desc, review_id desc;

create view training_seats as
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
          and r.decision is distinct from 'cleared');

create view training_decisions as
  select d.* from decisions d
    join training_seats t on t.match_id = d.match_id and t.seat_id = d.seat_id;

-- ===== Access =====
alter table consents          enable row level security;
alter table trust_changes     enable row level security;
alter table client_signals    enable row level security;
alter table integrity_signals enable row level security;
alter table integrity_reviews enable row level security;
alter table identity.identities enable row level security;
alter table identity.passkeys   enable row level security;
alter table identity.sessions   enable row level security;
revoke all on all tables in schema public from public;
revoke all on all tables in schema identity from public;
do $$
declare r text;
begin
  -- Belt and braces on Supabase, where these roles exist and get default grants.
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all tables in schema identity from %I', r);
      execute format('revoke all on schema identity from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'canutell_export') then
    create role canutell_export nologin;
  end if;
exception when duplicate_object or unique_violation then
  null; -- roles are cluster-wide: another database's migration created it concurrently
end $$;
grant usage on schema public to canutell_export;
grant select on training_seats, training_decisions to canutell_export;
