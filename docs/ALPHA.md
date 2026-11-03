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
2. **(owner) Domain: done, `canutell.com`.**
   - **Web:** `https://canutell.com` is the one origin; `www.canutell.com` redirects to it.
   - **API (game server):** `api.canutell.com`.
   - **Passkeys are bound to `canutell.com`** for good. Changing the domain later would lock everyone
     out of their accounts.
   - `fly.server.toml` is already set up for this (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `CORS_ORIGIN`).
3. **(owner) Supabase project.**
   - Create the project.
   - Copy the **direct connection** or **session pooler** connection string; add `?sslmode=require`.
   - You don't need to migrate by hand: each server deploy runs `node dist/db-cli.mjs migrate` first
     (`release_command` in `fly.server.toml`). To check from your machine instead:
     ```sh
     export DATABASE_URL='postgres://…?sslmode=require'
     pnpm db:status          # 0001–0007 applied after the first deploy
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
   - `fly.server.toml` is set for `canutell.com`. Check `GAME_NIGHTS` (your schedule) and
     `primary_region` (`mad`, Madrid) in both toml files.
   - `fly.agents.toml` already sets `AGENT_CHAT_MODEL=claude-haiku-5-5`, the owner's choice for the alpha.
6. **(owner) Secrets** (never in the toml files):

   ```sh
   SECRET=$(openssl rand -hex 32)
   fly secrets set --app canutell-agents AGENT_SERVICE_SECRET=$SECRET ANTHROPIC_API_KEY=…
   fly secrets set --app canutell-server AGENT_SERVICE_SECRET=$SECRET DATABASE_URL='postgres://…'
   ```

   Without `ANTHROPIC_API_KEY`, agents chat from scripted lines, and matches are flagged `scripted_chat`.

   **Alerts:** create an incoming webhook (Slack: an app with "Incoming Webhooks" for one channel;
   Discord: channel settings → Integrations → Webhooks), then

   ```sh
   fly secrets set --app canutell-server ALERT_WEBHOOK_URL='https://hooks.slack.com/services/…'
   ```

   Without it, alerts only go to `fly logs` (lines starting `ALERT`).

7. **Deploy** from the repo root:
   ```sh
   fly deploy --config fly.agents.toml --ha=false   # one machine; private, no public address
   fly deploy --config fly.server.toml --ha=false   # migrates first, then exactly one machine
   fly status --app canutell-server                 # one machine, health check passing
   fly certs add api.canutell.com --app canutell-server   # prints the DNS records to create for `api`
   ```
8. **(owner) Web on Vercel.** `vercel.json` at the repo root defines one service, `web` (`apps/web`,
   Next.js), public on every path. The game server and the agent service are not Vercel services: they
   hold long-lived WebSockets and in-memory matches, so they stay on Fly (DECISIONS "Vercel hosts the web
   app only").
   - Import the repo as a project, with the repo root as its root directory. `vercel.json` points the
     `web` service at `apps/web` and installs with pnpm from the root lockfile.
   - Set `NEXT_PUBLIC_SERVER_URL=wss://api.canutell.com` for Production. The build refuses to run without
     it.
   - Add the custom domains `canutell.com` and `www.canutell.com`, with `www` redirecting to the apex.
     Create the DNS records Vercel shows for each.
   - **Keep the apex as the only origin.** Passkey sign-in works only on `https://canutell.com`; a page
     served on `www` without redirecting would fail sign-in.
9. **Smoke test production:**
   - `curl https://api.canutell.com/health` returns `{"ok":true,…}`.
   - The alerts channel got `[server_started] server started: alpha, accounts only, invites, …`.
   - `curl https://api.canutell.com/api/game-nights` returns the next windows.
   - `https://www.canutell.com` redirects to `https://canutell.com`.
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
- **Watch the alerts channel** (and `fly logs --app canutell-server` for detail). Each kind of alert
  fires at most once per 10 minutes; repeats are counted in the next message.

  | Alert            | What to do                                                                     |
  | ---------------- | ------------------------------------------------------------------------------ |
  | `db_write`       | **At once.** Match data is being lost. Check Supabase status and `fly logs`.   |
  | `match_aborted`  | A server bug ended a match. Find `match … aborted:` in the logs and report it. |
  | `agent_fallback` | The agent service is down or slow: `fly status --app canutell-agents`, logs.   |
  | `studio_paused`  | A Studio agent hit three blocked lines. Look at it: `pnpm ops:studio show`.    |
  | `http_500`       | An API bug. The full error is in the logs.                                     |
  | `server_started` | Expected after a deploy. Unexpected ones mean a crash loop or a host restart.  |

  Alerts never contain player ids, IPs or chat.

- `match … formed … queue waits ms: min … median … max …` log lines are the queue-wait numbers.
- **Rate limits** (on by default) refuse sign-up starts after 10 per hour from one network, sign-in starts
  after 30 per 10 minutes, and new connections after 30 per minute. If a whole group plays from one venue's
  Wi-Fi and hits them, raise them for the night: `fly secrets set --app canutell-server
RATE_LIMITS='register=40/1h,socket=120/1m'` (that restarts the server, so do it before the window).
- **When a game night is quiet:** queues show no counts, by design (CLAUDE.md invariant 7). If few
  people turn up, the fix is the schedule, not the rules.

## 3. Weekly operations

```sh
pnpm ops:report --since-days 7         # fun first (completion, return rate, survey), then data
pnpm db:integrity pending              # flagged seats: match, seat, signal values; never who
pnpm db:integrity review --match ID --seat N --decision cleared|confirmed --reviewer YOU [--note …]
pnpm db:humanlikeness                  # H per agent version, from consented T2+ voters, non-party matches
pnpm ops:studio recent --since-days 7  # new Studio agents and edits: name, style hint, strikes
```

- **Review every flag within a week.** A flag never bans anyone; until it is reviewed, it keeps that
  seat out of the training pool and holds the player one trust level lower.
- **Read the survey comments** (`match_feedback`, already masked) for bugs and confusion. Comments are
  never used for training.
- **Deleting a player's data** on request: the player can do it from `/account`. If they ask you
  instead, ask for one of their match links and their seat, then run
  `pnpm db:delete-account --match ID --seat N --yes`. It is the same deletion path, and you never handle
  a player id.

## 3b. Turning on Agent Studio (Phase 7)

- **When:** after the first **100 completed alpha matches** with `baseline-1` only. `pnpm ops:report`
  shows the count. That gives humanlikeness (H) a clean baseline.
- **How:**
  ```sh
  fly secrets set --app canutell-server STUDIO=1   # or edit fly.server.toml and redeploy
  ```
  `STUDIO_SHARE` (default `0.5`) is the chance each public agent seat goes to a player-made agent. The
  rest stay `baseline-1`, the control.
- **Makers can build agents before it's on;** the agents just aren't seated yet.
- **Watch for** the `studio_paused` alert. A paused agent resumes when its maker saves a new version.

### Moderating Studio agents

The automatic checks block person-like names, contact details and links. They can't catch everything: a
slur, a celebrity's first name, or a style hint that steers an agent toward harassment. Read
`pnpm ops:studio recent` weekly, and act by agent name or id:

```sh
pnpm ops:studio show --agent Marlowe                                   # versions, strikes, past actions
pnpm ops:studio suspend --agent Marlowe --reason "name impersonates a streamer" --by YOU
pnpm ops:studio unsuspend --agent Marlowe --by YOU
pnpm ops:studio rename --agent Marlowe [--to Tidyname] --reason "offensive name" --by YOU
pnpm ops:studio retire --agent Marlowe --reason "harassing style hint" --by YOU
```

- **Suspend** stops the agent everywhere (public and private matches). The maker sees "Suspended by the
  moderators: <reason>", can't edit it, and can only retire it. Only `unsuspend` lifts it.
- **Rename** (default `Agent-<id>`) changes the name everywhere, past reveals included. The old name can't
  be used by a new agent.
- Every action is recorded for good (`studio_moderation`). Write reasons the maker can read.
- The output never shows who made an agent. Inside the server image:
  `fly ssh console --app canutell-server -C "node dist/db-cli.mjs studio recent"`.

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
| Rate limits        | `apps/server/src/rate-limit.ts` (defaults), `RATE_LIMITS` to override              |
| Alerts             | `apps/server/src/alerts.ts`, `ALERT_WEBHOOK_URL`                                   |
| Agent service      | `services/agents/README.md`, `fly.agents.toml`                                     |
| Images             | `apps/server/Dockerfile`, `services/agents/Dockerfile` (build from the repo root)  |
| CI                 | `.github/workflows/ci.yml`                                                         |
| Consent texts      | `packages/protocol/src/consent.ts` → `docs/consent/`                               |
| What is never kept | email, phone, birth date, user-agent strings, raw chat, invite codes (hashes only) |
