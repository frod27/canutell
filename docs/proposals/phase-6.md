# Phase 6 proposal: closed alpha (30–50 players)

Status: **draft for approval.** Nothing is built yet. This needs approval of the plan, of migration 0004,
and answers to the open questions at the end.

## Goal

Real people play real matches, and we learn two things:

- **Fun first:** do they finish matches, come back, and rate them well?
- **Data second:** the first clean, consented, research-eligible matches; a first humanlikeness (H)
  baseline for `baseline-1`; and integrity thresholds tuned against real players.

Alpha matches are the first ones with no build-phase flag. Everything before them is dev data and must be
purged first.

## What I can build, and what only you can do

**I can build** everything in the repo: deployment files, invite-only access, a post-match survey, an
operations report, the game-night schedule, CI, and an alpha runbook (`docs/ALPHA.md`).

**Only you can do:**

- create the hosting accounts and the Supabase project;
- choose and buy the domain (passkeys are bound to it, so it can't change casually later);
- have the consent texts reviewed by a lawyer;
- set `ANTHROPIC_API_KEY` for agent chat;
- invite the players.

The runbook lists each step in order, with the exact commands.

## The thin-queue problem (open question 2)

**The constraint.** A match needs 4 humans, because the agent cap is 0–2 (SPEC §Match structure).
With 30–50 players spread over a day, 4 people will rarely be queued at the same moment. Long waits kill
fun, and an alpha that doesn't fill matches produces no data.

**The data constraint.**

- The queue must not show how many people are waiting (CLAUDE.md invariant 7): "4 waiting, match
  started" reveals 2 agents.
- Changing the agent cap changes the base rate players guess against, which breaks H comparisons
  (SPEC §Open questions, "Cold-start fill").

**Recommended: scheduled game nights.**

- **Fixed windows.** The owner sets them, e.g. Tue/Thu/Sun 20:00–22:00 in the alpha's main time zone.
- **The lobby shows the schedule:** "Next game night: Thu 20:00".
- **After 3 minutes in the queue,** the player sees: "Few players are online right now — matches fill
  best during game nights." This is a fixed timer, never a count, so it says nothing about who is waiting.
- **The rules stay the same.** The 0–2 agent cap is untouched and H stays comparable.
- **Outside the windows** the queue still works; it just fills more slowly.

## 1. Deployment

Containerised, so it can run on any host that keeps processes alive (not serverless; CLAUDE.md):

- **Game server.** A bundled build (esbuild, from the "Later" list), in a Dockerfile, running
  `node dist/server.mjs`. Its health check is the existing `/health`.
- **Agent service.** A Dockerfile using `uv`, reachable only from the game server over a private network,
  with the shared secret.
- **Web.** Vercel: `NEXT_PUBLIC_SERVER_URL=wss://<api domain>`.
- **Database.** A Supabase project: `pnpm db:migrate`, then the server's `DATABASE_URL` via the direct
  connection or the session pooler, with SSL.
- **Configuration per host** (open question 1). The runbook gives `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`,
  `CORS_ORIGIN` and the agent variables.
- **CI.** A GitHub Actions workflow runs typecheck, lint and format, the tests on PGlite and on a Postgres
  16 service, and the Python tests and lint. This was in "Later".

## 2. Closed access (open question 3)

**Recommended: invite-only accounts, and no guests during the alpha.**

- **Data reason.** Every alpha seat is then an account, so trust, consent and integrity apply to
  everyone. A guest seat can never enter the pool, and every guest in a match is a seat of lost data.
- **How it works:**
  - A server switch, `ACCOUNTS_ONLY=1`, makes a guest's `hello` fail with `account_required`.
  - Sign-up asks for an invite code first.
  - Bots and agents are unaffected; they are seated by the server.
- **Invite codes.**
  - Created by the operator: `pnpm ops:invite --uses 5 --label "friends of X"`. Codes are stored hashed,
    with a use limit, an expiry and revocation.
  - **Data tradeoff → data.** Each account records which invite it used, in the locked identity schema.
    People invited by the same person probably know each other, and friends who recognise each other's
    play bias detection. Analysis can then mark matches where several players share an invite, just as
    parties are tagged. Players never see this.

## 3. Post-match survey: fun, measured

- **Where:** on the reveal screen, one optional question: "How much fun was this match?" (1–5).
- **Optional extras:** tags (too long, too slow, confusing, great chat, felt unfair, bugs) and a comment
  of up to 500 characters.
- **Masked like chat.** The comment goes through the same masking as chat (phone numbers, emails, links).
- **One answer per seat per match,** from the seated account only.
- **Product data only.** It is never in the training views and never exported for training. The seat
  link exists so fun can be compared with what happened in the match.

## 4. Operations report

`pnpm ops:report [--since 7d]` prints numbers only, with no player ids:

- **Fun:** matches started and completed; completion rate; median time from queue to match; survey
  average and tags; returning players (2+ matches in the window).
- **Data:**
  - research-eligible seats (`training_seats`), and accounts by trust level and consent;
  - flags awaiting review;
  - H per agent version once it has data;
  - agent fallback rate, plus `latency_prior` and `scripted_chat` match counts.

## 5. Alpha tagging

- **Matches** carry the cohort flag `alpha`. It marks a cohort, not an exclusion, so alpha matches stay
  research-eligible.
- **The build-phase flag stops.** No `phaseN` flag is added once `ALPHA=1` is set on the server.

## Migration 0004 (proposed, needs approval)

```sql
-- 0004_alpha.sql — Phase 6. Invite codes, the invite each account used, and the post-match survey.
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
-- (plus the same anon/authenticated revokes as 0001/0003)
```

- **Survey answers are final.** Rows are append-only, one per seat.
- **Deletion.** Deleting an account also deletes that player's survey rows.
- **No export grant.** `canutell_export` gets nothing new.

## Files touched

- **Migration:** `supabase/migrations/0004_alpha.sql`.
- **`packages/protocol`:**
  - an `invite` field on the sign-up request;
  - the `match.feedback` HTTP schema;
  - the `account_required` error;
  - the lobby `schedule` in `welcome`: the next windows only, the same for everyone.
- **`packages/db`:**
  - `invites.ts`: create, list, revoke; redeem at sign-up, in the same transaction as the account;
  - `feedback.ts`;
  - `ops-report.ts`;
  - account deletion extended to survey rows;
  - CLI: `ops:invite`, `ops:report`.
- **`apps/server`:**
  - `ACCOUNTS_ONLY`, `ALPHA` and `GAME_NIGHTS` settings;
  - invite check at sign-up;
  - `POST /api/matches/:id/feedback`, seated account only;
  - the bundle build;
  - a Dockerfile.
- **`services/agents`:** a Dockerfile.
- **`apps/web`:**
  - an invite step in sign-up;
  - the survey on the reveal screen;
  - the game-night banner and the long-wait message.
- **`.github/workflows/ci.yml`.**
- **Docs:** `docs/ALPHA.md` (runbook: pre-flight checklist, launch, daily operations, exit criteria),
  `README.md` and `DECISIONS.md`.

## Tests

- **Invites:**
  - redeem within the use limit;
  - expired, revoked and used-up codes are refused;
  - the code is stored only hashed;
  - concurrent sign-ups can't exceed `max_uses`.
- **`ACCOUNTS_ONLY`:**
  - a guest is refused;
  - an account plays;
  - bots and agents are still seated;
  - the refusal looks the same however many people are waiting.
- **Survey:**
  - only a seated account, once, after the match is completed;
  - the comment is masked;
  - it never appears in the training views;
  - it is deleted with the account.
- **Game nights:** the banner and the long-wait message depend only on the schedule and the player's own
  wait, never on queue contents (invariant 7).
- **Ops report:** run over a load-test database; no player id in the output.
- **Load test:** in `ACCOUNTS_ONLY` + `ALPHA` mode, all Phase 5 audits, plus:
  - alpha matches have no build flag;
  - only research-consented T2 seats with no flag appear in `training_seats`.
- **Browser e2e:** sign-up with an invite, then the survey.
- **Docker:** both images build, and the server image answers `/health`.

## Exit criteria (proposed, for the runbook)

The alpha ends when either:

- 300 completed non-party matches with 30+ distinct players, **or**
- 6 weeks pass.

Success:

- median fun rating ≥ 4;
- ≥ 50% of players return for a second match;
- completion rate ≥ 90%;
- integrity false-positive rate measured on a reviewed sample.

## Open questions

1. **Hosting for the game server and the agent service.**
   - **Recommended:** host-agnostic Docker images plus a config for Fly.io, which runs long-lived
     WebSocket processes and private networking between apps.
   - **Alternatives:** Railway or Render; a single VPS with Docker Compose.
2. **Thin queues.**
   - **Recommended:** scheduled game nights, with the rules unchanged.
   - **Alternative:** allow up to 4 agents when the queue is thin. That changes the disclosure and the
     base rate, and those matches leave H.
   - **Alternative:** parties only.
3. **Who can play.**
   - **Recommended:** invite-only accounts, no guests.
   - **Alternatives:** invite-only accounts plus guests; or open sign-up.
4. **Approve the plan and migration 0004**, including recording each account's invite in the identity
   schema for analysis of friend groups.
