# Closed alpha runbook

The closed alpha (Phase 6) has 30–50 invited players, game nights, and the first research-eligible data.
Plan: [`docs/proposals/phase-6.md`](proposals/phase-6.md). Decisions: `docs/DECISIONS.md`, Phase 6.

**Who does what.** Steps marked **(owner)** need your accounts, money or judgement. Everything else is a
command to run.

## 1. Before launch: a checklist, in order

1. **(owner) Legal review of the consent texts.** The texts are in `docs/consent/`, generated from
   `packages/protocol/src/consent.ts`. If the wording changes, edit the `.ts` file and run
   `pnpm consent:docs`. A change in meaning needs a new version (DECISIONS "Phase 5": raise
   `CONSENT_VERSIONS`, plus a migration for the research version).
2. **(owner) Domain.**
   - Pick the web domain, e.g. `canutell.app`, and an API host, e.g. `api.canutell.app`.
   - **Passkeys are bound to the web domain.** Changing it later signs everyone out for good, so choose
     once.
3. **(owner) Supabase project.**
   - Create the project.
   - Copy the **direct connection** or **session pooler** connection string; add `?sslmode=require`.
   - From your machine, run:
     ```sh
     export DATABASE_URL='postgres://…?sslmode=require'
     pnpm db:migrate && pnpm db:status          # 0001–0004 applied
     ```
   - The server connects as the database owner. Every table has row-level security with no policies,
     and the `anon` and `authenticated` roles are revoked, so Supabase's public API exposes nothing.
4. **Purge dev data** (only if this database ever held dev matches):
   ```sh
   for f in phase2 phase3 phase4 phase5; do pnpm db:purge --flag $f --yes; done
   ```
5. **(owner) Fly.io.** Install `flyctl`, sign in, and create two apps in the same organization:
   ```sh
   fly apps create canutell-server
   fly apps create canutell-agents
   ```
   - Edit `fly.server.toml`: set `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` and `CORS_ORIGIN` to your web
     domain, `GAME_NIGHTS` to your schedule, and `primary_region` near your players.
   - `fly.agents.toml` already sets `AGENT_CHAT_MODEL=claude-haiku-5-5`, the owner's choice for the alpha.
6. **(owner) Secrets** (never in the toml files):
   ```sh
   SECRET=$(openssl rand -hex 32)
   fly secrets set --app canutell-agents AGENT_SERVICE_SECRET=$SECRET ANTHROPIC_API_KEY=…
   fly secrets set --app canutell-server AGENT_SERVICE_SECRET=$SECRET DATABASE_URL='postgres://…'
   ```
   Without `ANTHROPIC_API_KEY`, agents chat from scripted lines, and matches are flagged `scripted_chat`.
7. **Deploy** from the repo root:
   ```sh
   fly deploy --config fly.agents.toml
   fly deploy --config fly.server.toml
   fly scale count 1 --app canutell-server   # matches live in memory: exactly one machine
   fly certs add api.canutell.app --app canutell-server   # then point the DNS record at Fly
   ```
8. **(owner) Web on Vercel.**
   - Import the repo with root directory `apps/web`; Vercel uses the root `pnpm-lock.yaml`.
   - Set `NEXT_PUBLIC_SERVER_URL=wss://api.canutell.app`.
   - Add the custom domain `canutell.app`.
9. **Smoke test production:**
   - `curl https://api.canutell.app/health` returns `{"ok":true,…}`.
   - `curl https://api.canutell.app/api/game-nights` returns the next windows.
   - On a phone: open the site and see "Closed alpha".
   - Sign up with a test invite and play a match with 3 friends during a game night.
   - Then delete the test account from its account page.
10. **Invites** (codes are shown once and stored hashed):
    ```sh
    pnpm ops:invite create --uses 10 --label "first wave: owner's friends" --expires-days 30
    pnpm ops:invite list
    pnpm ops:invite revoke --id 3
    ```
    To run the CLI inside the server image instead of locally:
    `fly ssh console --app canutell-server -C "node dist/db-cli.mjs invite list"`.

## 2. Running a game night

- **Deploy outside the windows only.** A restart aborts running matches, and players can't rejoin them.
- **Post a reminder** in the channel you invite players through, 30 minutes before. The lobby shows the
  schedule too.
- **Watch the logs:** `fly logs --app canutell-server`.
  - `match … formed … queue waits ms: min … median … max …` lines are the queue-wait numbers.
  - `DB WRITE FAILED` lines need attention at once.
- **When a game night is quiet:** queues show no counts, by design (CLAUDE.md invariant 7). If few
  people turn up, the fix is the schedule, not the rules.

## 3. Weekly operations

```sh
pnpm ops:report --since-days 7         # fun first (completion, return rate, survey), then data
pnpm db:integrity pending              # flagged seats: match, seat, signal values; never who
pnpm db:integrity review --match ID --seat N --decision cleared|confirmed --reviewer YOU [--note …]
pnpm db:humanlikeness                  # H per agent version, from consented T2+ voters, non-party matches
```

- **Review every flag within a week.** A flag never bans anyone; until it is reviewed, it keeps that
  seat out of the training pool and holds the player one trust level lower.
- **Read the survey comments** (`match_feedback`, already masked) for bugs and confusion. Comments are
  never used for training.
- **Deleting a player's data** on request: the player can do it from `/account`. If they ask you
  instead, ask for one of their match links and their seat, then run
  `pnpm db:delete-account --match ID --seat N --yes`. It is the same deletion path, and you never handle
  a player id.

## 4. Exit criteria (docs/proposals/phase-6.md)

The alpha ends at **300 completed non-party matches with 30+ distinct players**, or after **6 weeks**,
whichever comes first.

**Success:**

- median fun ≥ 4;
- ≥ 50% of players return for a second match;
- completion rate ≥ 90%;
- integrity false-positive rate measured on a reviewed sample.

**Then:**

- export the human timing model: `pnpm db:latency-model --out services/agents/data/latency.json`.
  Agents stop using the placeholder prior as each bucket passes 200 samples.
- record the first H baseline for `baseline-1`;
- tune the integrity thresholds against the reviewed flags.

## 5. Where things are

| What               | Where                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Game server config | `apps/server/src/main.ts` (all environment variables), `fly.server.toml`           |
| Agent service      | `services/agents/README.md`, `fly.agents.toml`                                     |
| Images             | `apps/server/Dockerfile`, `services/agents/Dockerfile` (build from the repo root)  |
| CI                 | `.github/workflows/ci.yml`                                                         |
| Consent texts      | `packages/protocol/src/consent.ts` → `docs/consent/`                               |
| What is never kept | email, phone, birth date, user-agent strings, raw chat, invite codes (hashes only) |
