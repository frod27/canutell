# Phase 5 proposal: accounts, trust levels, consent flows, integrity signals

Status: **draft for approval.** Nothing is built yet. This needs approval of the plan, of migration 0003,
and answers to the open questions at the end. The engine and the rules don't change in this phase.

## Goal

From Phase 5, data can become training-eligible. A seat's data enters the training pool only when every
gate holds (CLAUDE.md invariant 10, SPEC §Training loop):

- **Account:** the player has an account, signed in with a passkey.
- **Age:** the player has confirmed they are 18 or older. Together with the account, this makes them T2.
- **Consent:** the player has active research consent at export time.
- **Integrity:** the seat carries no automation flag that is still unreviewed or was confirmed.

Each gate is enforced in one place, a database view, so exports can't get it wrong.

Phase 5 matches are still dev data: they are flagged `phase5` and never eligible. Real eligibility starts
with the closed alpha (Phase 6), whose matches carry no build flag.

## 1. Accounts and sign-in

- **Passkeys only in Phase 5** (SPEC §Integrity, T2: "passkey or phone verification").
  - The game server runs WebAuthn with `@simplewebauthn/server` 14.0.3 (released 2026-09-25); the web
    client uses `@simplewebauthn/browser` 14.0.0 (released 2026-09-02).
  - Sign-in is usernameless: discoverable credentials, user verification required.
  - Attestation is `none`, so no authenticator model is collected.
- **No email and no phone.** Nothing personal is collected. The `email_hash` column exists (SPEC) but stays
  empty. Phone verification goes under "Later": it needs an SMS provider and collects a phone number.
- **Sessions.**
  - A random 256-bit token, stored only as its SHA-256 hash, valid for 30 days, revocable.
  - It replaces the in-memory guest token, so a reveal can be reopened from any device and after a
    server restart. That lifts the Phase 3 limitation.
- **Passkeys belong to the domain, not the provider.** They are bound to the relying-party ID, i.e. the
  web origin's domain. A later move to Supabase Auth or another provider can keep them, as long as the
  domain stays the same (open question 1).
- **Guests still play** without an account. The lobby offers "Create account" but never requires it.

## 2. Trust levels (SPEC §Integrity)

| Level  | Reached when                                                                      | Lowered when                                                    |
| ------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **T0** | Guest (no account)                                                                | n/a                                                             |
| **T1** | A passkey account is created                                                      | An automation flag on a T2 seat; a reviewer confirms automation |
| **T2** | T1 and the player confirms they are 18+                                           | An automation flag on a T3 seat                                 |
| **T3** | T2 and the player's last 10 completed non-dev matches played at T2+ are all clean | n/a                                                             |

- **A flag lowers trust by one level at once** (SPEC: "Flags lower trust"). A reviewer then either clears
  the flag, which restores the level, or confirms it, which leaves the player at T1 until a reviewer
  restores them.
- **No automatic bans** (SPEC). Play is never affected by trust; only data use is.
- **Every change is logged** in `trust_changes` (append-only), with its reason and match.
- **Two checks at export time (data quality wins):**
  - **At match time:** `seats.trust_level_at_match` is recorded when the match starts.
  - **Now:** the player's current level must also be T2 or higher. So a later automation finding also
    removes their past matches.
- **Trust is never shown to other players** (CLAUDE.md invariant 7). Agents have no accounts, so a
  "verified" badge on a seat would give agents away. Seats show no account status before or after Reveal.
  A player sees only their own trust level.

## 3. Consent flows (SPEC §Consent and privacy)

A `consents` table holds one row per grant: type, version, granted, revoked. It replaces
`players.research_opt_in`, which migration 0003 drops; it is false everywhere today. A row can only be
revoked, once, and never otherwise edited or deleted.

**Sign-up flow** (web, mobile-first), one step per screen:

1. **Terms v1** (required). What is kept for play (match history, scores) and what is never collected.
2. **Create a passkey.** The account now exists at T1.
3. **Age.** The player enters the month and year of their birth (open question 2).
   - Only `age_confirmed` true or false is stored, never the date.
   - Under 18: the account stays T1 for good, with play only and nothing kept for training. The answer
     can't be changed in the app.
4. **Research opt-in.** A separate screen, unticked by default, in plain language:
   - **What is used:** decisions, timing, masked chat, ballots.
   - **What for:** training and evaluating CANUTELL's own AI players only. Never sold; never deployed
     outside CANUTELL (SPEC).
   - **Revocable** at any time; revoking removes the player from future exports.
   - Skipping it is one tap, and play is unaffected.

**Account page** (`/account`):

- the player's own trust level and what it means;
- research consent on or off;
- passkeys (add another, remove one);
- sign out everywhere;
- delete account (open question 3).

**Consent text versions.** The texts live in `docs/consent/terms-v1.md` and `research-v1.md`. Raising the
required version is a migration, and players are asked again. **These drafts need legal review before the
alpha.** I'll write them plainly, but they are not legal advice.

**What each data use requires.** SPEC is ambiguous here: the integrity table lists "research" for T3, while
§Consent calls the research opt-in the gate for training. Proposed reading, added to SPEC:

| Use                                             | Needs                                   |
| ----------------------------------------------- | --------------------------------------- |
| Training (Mimic, agent timing model)            | T2+ and active research consent         |
| Evaluation (H, detection metrics)               | T2+ voters with active research consent |
| Research (behavioral analyses beyond the above) | T3 and active research consent          |

The stricter option is chosen for evaluation, which today counts every human voter. That shrinks the H
sample, but no one's ballots are analysed without consent.

## 4. Integrity signals (SPEC §Integrity)

**Collection.**

- **The client sends two new frames:**
  - `client.env` once per connection: booleans only (`webdriver`, `headlessUserAgent`, `noLanguages`,
    `zeroOuterSize`). No raw fingerprint, no user-agent string, no hash that could follow a person.
  - `focus` / `blur` while in a match.
- **The server adds its own checks:** a `HeadlessChrome` user agent at the WebSocket upgrade, reduced to a
  boolean.
- **Stored only for account holders.** Signals go to `client_signals`, an append-only log table with
  server timestamps. Guests' signals are discarded, because nothing about a guest is kept.

**Derivation.** One pure function turns the log, timings and client signals into `integrity_signals`
(SPEC table) at match end. It can be rebuilt like every other derived table.

| Signal              | Value                                                                                                                                    | Flagged when (initial threshold, to be tuned in the alpha) |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `latency_cv`        | Coefficient of variation of the seat's server-measured, non-timeout decision latencies                                                   | < 0.15 with ≥ 8 decisions                                  |
| `fast_replies`      | Chat messages sent sooner after a message to that seat than reading it (240 ms/word) plus typing their own text at 15 chars/s would take | ≥ 3                                                        |
| `pastes`            | Pasted chat messages (client-reported)                                                                                                   | ≥ 3                                                        |
| `blur_then_paste`   | A pasted message within 30 s of returning to the tab: the "asked another AI" pattern                                                     | ≥ 2                                                        |
| `blur_ms`           | Total time the tab was hidden during prompts                                                                                             | never flagged on its own (recorded)                        |
| `headless`          | Any headless indicator, from the client or the server                                                                                    | true                                                       |
| `no_client_signals` | The seat never sent `client.env`, i.e. it isn't our web client                                                                           | true                                                       |

- **Agent and bot seats** get the same signals computed. They never affect anyone's trust and are never
  shown to players.
- **Review CLI.** It shows match, seat, signals and values, and never identity data:
  - `pnpm db:integrity pending` lists flagged seats.
  - `pnpm db:integrity review --match M --seat S --decision cleared|confirmed --reviewer NAME [--note]`
    records a decision.

## 5. Guests and deleted accounts (SPEC T0: "nothing kept beyond the match")

**The conflict.** A guest's actions are part of every other seat's view: what they invested, staked and
said. Deleting a guest's events would break replay, and with it the training value of the T2 players
in the same match. SPEC's sentence can't be applied literally without that loss, so this needs your
decision (open question 3).

**Recommended: keep the match, forget the person.**

- **Fresh pseudonym per match.** A guest seat is stored under a pseudonymous player id that is new for
  each match, so nothing links a guest's matches together in storage.
- **Nothing else about the guest is kept:** no client signals, no integrity rows, no identity.
- **Context, never a target.** The guest's actions stay in the log only as context for the other seats.
  They are never a training or evaluation target, because the guest is T0.
- **Chat is redacted at export.** A training export replaces chat text from any seat outside the
  training pool with a placeholder. The log itself is never edited, so replay stays byte-identical.
- **Deleting an account works the same way:**
  - the privacy-deletion job removes the identity, passkeys and sessions;
  - all consents are revoked and `players.deleted_at` is set;
  - the player's past seats become anonymous context, like a guest's.
  - **Trade-off:** their masked chat stays in the log, with no link to any identity, and is never
    exported. A stricter option is under question 3.

## 6. Data views and the export role

- `active_research_consent` and `seat_review_status` (the latest review decision per flagged seat).
- `training_seats`: every gate from the Goal section, plus a completed match and no dev, bot-fill or
  sped-up flag. It does not join `identities` (CLAUDE.md invariant 9).
- `training_decisions`: `decisions` restricted to `training_seats`.
- **Repointed queries:**
  - `pnpm db:latency-model` reads `training_decisions` (aggregates only, as now).
  - `pnpm db:humanlikeness` counts only voters in `training_seats`.
- **Export role.** A `canutell_export` role (no login) may read only the two training views. Identity
  tables live in a separate `identity` schema with no grants at all.

## Migration 0003 (proposed, needs approval)

```sql
-- 0003_accounts_consent_integrity.sql — Phase 5.
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
-- (plus the same anon/authenticated revokes as 0001, for both schemas)

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'canutell_export') then
    create role canutell_export nologin;
  end if;
end $$;
grant usage on schema public to canutell_export;
grant select on training_seats, training_decisions to canutell_export;
```

## Files touched

- **`supabase/migrations/0003_accounts_consent_integrity.sql`** (above).
- **`packages/protocol`:**
  - new client frames: `client.env`, `focus`, `blur`;
  - `welcome` gains `account: { trustLevel, researchConsent } | null` (the player's own only);
  - zod schemas for the HTTP auth and account API;
  - required consent versions;
  - regenerated JSON schemas.
- **`packages/db`:**
  - `integrity.ts`: pure derivation of `integrity_signals`;
  - `accounts.ts`: identities, passkeys, sessions, consents, trust transitions, account deletion through
    the privacy-deletion path;
  - store support for `client_signals`;
  - latency model and H repointed at the training views;
  - CLI: `db:integrity pending|review`.
- **`apps/server`:**
  - `auth.ts`: WebAuthn registration and sign-in endpoints, behind an interface so tests can use a fake
    verifier;
  - session tokens in `hello` and `Authorization`;
  - `trust_level_at_match` recorded for real;
  - a fresh guest pseudonym per match;
  - client signals stored for account seats only;
  - integrity and trust updates at match end;
  - CORS for POST;
  - `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` configuration.
- **`apps/web`:** sign-up and sign-in screens, age step, research opt-in, `/account`, signal collection,
  session storage.
- **`docs/consent/`:** draft texts.
- **`docs/SPEC.md`:** the data-use table and the T0 wording, per your answers.
- **`docs/DECISIONS.md`**, **`README.md`**.

## Tests

- **Migration 0003 on PGlite and Postgres 16:**
  - the consent guard: revoke once, no other edit;
  - the append-only triggers;
  - the `training_seats` gates, each one toggled on its own.
- **Integrity derivation:** each signal, with thresholds at their boundaries.
- **Trust transitions:**
  - promotion to T3 after 10 clean matches;
  - demotion by a flag;
  - review cleared or confirmed;
  - an under-18 account staying at T1.
- **Server:**
  - registration and sign-in with a fake verifier;
  - session resume across a server restart;
  - a guest gets a fresh pseudonym in each match;
  - guest signals are discarded;
  - no frame to another player carries account or trust data;
  - account deletion.
- **Browser e2e with Chromium's virtual WebAuthn authenticator** (real passkey ceremonies):
  - sign up, confirm age, opt in;
  - play a quick match against bots;
  - reopen the reveal after a server restart, from a fresh browser context signed into the same account;
  - revoke consent;
  - delete the account.
- **Load test** (200 matches per mode, Postgres):
  - all Phase 4 audits;
  - every bot-held "human" seat is flagged `no_client_signals` (the detector catches scripted clients);
  - no agent or bot seat changes anyone's trust;
  - `training_seats` is empty, because every match is `phase5`.
- **Unchanged:** the engine, so the 10,000-match simulator is unaffected; it still runs in the suite.

**Known gap.** False-positive rates need real people. The thresholds above are starting values, measured
and tuned in the closed alpha, and flags never ban anyone.

## Open questions

1. **Sign-in provider.**
   - **Recommended:** passkeys in our own game server (SimpleWebAuthn), with credentials stored in our
     Postgres, which becomes the Supabase database later.
   - **Why not Supabase Auth now:**
     - there is no Supabase project yet;
     - its passkey support is a beta its docs call experimental;
     - [registering a passkey there needs an existing, confirmed, non-anonymous user](https://supabase.com/docs/guides/auth/passkeys),
       which means collecting an email address or phone number first.
2. **How "confirmed 18+" works.**
   - **Recommended:** self-attested month and year of birth; only the result is stored.
   - **Alternatives:** a plain "I'm 18 or older" checkbox, or a third-party age-verification provider
     (which keeps everyone at T1 until it is integrated).
3. **Guests and deleted accounts.**
   - **Recommended:** keep the match, forget the person (section 5).
   - **Stricter:** on account deletion, also redact that player's chat in the log. The privacy-deletion
     job may edit events; the match then no longer replays byte-identically and leaves the training pool.
4. **Approve the plan and migration 0003**, including the data-use table, which also requires research
   consent for evaluation.
