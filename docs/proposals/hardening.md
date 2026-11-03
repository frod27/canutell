# Pre-launch hardening proposal: rate limits, Studio moderation, alerts

Status: **approved 2026-11-03.** Owner answers: a new `suspended` status (recommended), a Slack/Discord
webhook for alerts (recommended), and the plan and migration 0007 as written. Implementation notes are in
DECISIONS.md under "Pre-launch hardening".

## 1. Rate limits

Today a script can call sign-up, sign-in and the Studio endpoints as fast as it likes, and open any number
of sockets. The game server runs as a single machine (`--ha=false`), so in-memory token buckets are enough.

| What                                         | Key         | Limit (default)            |
| -------------------------------------------- | ----------- | -------------------------- |
| `POST /api/auth/register/*` (invite guesses) | client IP   | 10 per hour                |
| `POST /api/auth/login/*`                     | client IP   | 30 per 10 minutes          |
| Other `/api/me*` and feedback                | client IP   | 120 per minute             |
| Studio writes (create, new version, retire)  | account     | 30 per hour; 5 creates/day |
| Public reads (leaderboard, names, nights)    | client IP   | 240 per minute             |
| New WebSocket connections                    | client IP   | 30 per minute              |
| Agent seats, `/internal/*`, `/health`        | not limited |                            |

- An over-limit request gets `429 {error: "rate_limited"}` with `Retry-After`. A refused socket closes
  with code 1013 ("try again later"). The web client shows "Too many tries, wait a minute".
- **Client IP:** Fly's proxy sets `Fly-Client-IP`. It is trusted only when `CLIENT_IP_HEADER=fly-client-ip`
  is set (in `fly.server.toml`); otherwise the socket address is used.
- **Privacy:** IPs live in memory only, for at most the bucket window. They are never logged, stored or put
  in alerts (CLAUDE.md invariant 9).
- Limits are env-tunable (`RATE_LIMITS=off` for the load test and e2e).

## 2. Studio moderation

The automatic name and style checks miss things like slurs, impersonation of a celebrity by first name,
or a style hint that steers the agent towards harassment. An operator needs to act by agent name, with a
reason, and leave a record.

```
pnpm ops:studio recent [--since-days 7]                 new agents and versions: name, style hint, strikes
pnpm ops:studio show --agent NAME|ID                    status, versions, strikes, moderation history
pnpm ops:studio suspend --agent X --reason TEXT --by NAME
pnpm ops:studio unsuspend --agent X --by NAME
pnpm ops:studio rename --agent X [--to NAME] --reason TEXT --by NAME   (default name "Agent-<id>")
pnpm ops:studio retire --agent X --reason TEXT --by NAME
```

- **A new status, `suspended` (open question 1).** Today a strike pause is lifted when the maker saves a
  new version. A moderator's hold must not be lifted that way. A suspended agent plays nowhere (public or
  private); the maker sees "Suspended by the moderators: <reason>" and can only retire it.
- **Rename** keeps the agent and its versions; only the display name changes. Past reveals then show the
  new name, which is what you want for a bad name.
- `recent` shows maker-written text (names and style hints) to the operator. It never shows who the maker
  is: owner ids stay out of the output, as in the other ops commands.

### Migration 0007 (needs approval)

- `studio_agents.status` check widened to `active | paused | suspended | retired`.
- New table `studio_moderation`, append-only (same trigger as the event log): `agent_id`, `action`
  (`suspend | unsuspend | rename | retire`), `reason`, `moderator` (a free-text operator name, not a player),
  `old_name`, `new_name`, `at`. RLS on, no grants, like the other Studio tables.
- Data affected: none existing. It touches no match, seat or training view.

## 3. Alerts

One env var, `ALERT_WEBHOOK_URL` (open question 2). The server posts `{"text": …, "content": …}`, which
Slack and Discord incoming webhooks both accept. It sends:

| Alert                                             | Why it matters                                |
| ------------------------------------------------- | --------------------------------------------- |
| A match log write to Postgres failed              | Data loss: the one alert that must never wait |
| A match aborted by an engine error (not shutdown) | A rules or server bug                         |
| An agent seat fell back to a scripted bot         | Agent service down or slow (`agent_fallback`) |
| A Studio agent was paused by strikes              | Someone to look at with `ops:studio show`     |
| An HTTP API answered 500                          | A bug                                         |
| Server started (with version and flags)           | So you notice restarts and crash loops        |

- **Throttled:** the same alert key fires at most once per 10 minutes, and the next message says how many
  were suppressed. A send is fire-and-forget with a 5-second timeout and never blocks a match.
- **Content:** codes, counts, match ids and agent labels only. No player ids, IPs, chat or stack traces
  (the full error stays in `fly logs`).
- Without `ALERT_WEBHOOK_URL`, alerts are only logged, as today.

## Files touched

- `supabase/migrations/0007_studio_moderation.sql`; `packages/db/src/studio.ts` (moderation functions,
  `suspended` handling in eligibility, versions and party seating); `packages/db/src/cli.ts` (`ops:studio`);
  `package.json` script.
- `packages/protocol/src/studio.ts`: `suspended` in the status enum.
- `apps/server/src/rate-limit.ts` (new), `apps/server/src/alerts.ts` (new); `server.ts`, `accounts-api.ts`,
  `studio-api.ts`, `main.ts` wiring; `fly.server.toml` (`CLIENT_IP_HEADER`).
- `apps/web`: show `rate_limited` and `suspended` clearly on the sign-in and Studio pages.
- Docs: `ALPHA.md` (moderation and alerts in the runbook), `DECISIONS.md`, README env list.

## Tests

- Rate limiter unit tests on a fake clock: refill, per-key isolation, eviction, `Retry-After`.
- Server tests: the 11th registration in an hour gets 429; a 31st socket is closed with 1013; agents and
  `/internal` are never limited; `Fly-Client-IP` is ignored unless configured.
- db tests: suspend takes an agent out of public and private seating; saving a version does not lift a
  suspension; rename keeps versions and changes `studioNames`; every action writes one moderation row,
  which can't be updated or deleted.
- Alerts: a fake webhook receives a DB-failure alert; throttling collapses repeats into one message with a
  count; payloads contain no `p_` ids.
- Full suite on PGlite and Postgres, e2e, and the load test with limits on at alpha scale (no 429s for
  normal play).

## Open questions

1. **Moderator hold:** a new `suspended` status that the maker can't lift (recommended), or reuse `paused`
   (then saving a new version would undo a moderator's pause)?
2. **Alert channel:** a Slack or Discord webhook (recommended, free, one env var), or email (needs an
   email provider and its API key)?
3. **Approve migration 0007 as written?**
