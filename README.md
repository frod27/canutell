# CANUTELL

A browser-first social deduction game: six seats, 0–2 of them secretly AI agents. Players invest, deal,
gamble and vote, then label every other player as human or agent. Rules and data schema:
[`docs/SPEC.md`](docs/SPEC.md). Build contract: [`CLAUDE.md`](CLAUDE.md). Decisions:
[`docs/DECISIONS.md`](docs/DECISIONS.md).

**Current phase: 5 — accounts, trust levels, consent flows, integrity signals** (Phases 1–4 are complete).

```sh
pnpm install
pnpm test                                    # all unit + integration tests
pnpm sim --matches 10000 --mode full         # engine simulator (also --mode quick | both)
pnpm loadtest --matches 200 --mode both      # real matches over WebSockets, fully audited
pnpm loadtest --agents python                # same, with the Python agent service in every agent seat
pnpm agents:test && pnpm agents:lint         # Python agent service (needs uv)
pnpm typecheck && pnpm lint && pnpm format:check
```

Play locally:

```sh
pnpm serve:dev     # game server on :8787; fills empty seats with bots after 5 s (dev only)
pnpm web           # web client on http://localhost:3000
```

`pnpm serve` runs the server without bot fill. It is configured by environment variables; see
`apps/server/src/main.ts` for the full list. The web client connects to `NEXT_PUBLIC_SERVER_URL`, or to
port 8787 on the page's host.

**Storage.**

- **With `DATABASE_URL`** (any Postgres; Supabase when there is a project), matches are written to
  Postgres, reveals can be reopened at `/match/<id>`, and players can create passkey accounts
  (`WEBAUTHN_RP_ID`, the web domain, default `localhost`; `WEBAUTHN_ORIGINS`, default
  `http://localhost:3000`).
- **Without it,** they go to `data/matches/<matchId>/` as append-only JSONL, and everyone plays as a guest.

```sh
export DATABASE_URL=postgres://user@host:5432/canutell
pnpm db:migrate                       # apply supabase/migrations/NNNN_*.sql (the server refuses to start if any are pending)
pnpm db:status                        # applied / pending migrations
pnpm db:derive [--match ID]           # rebuild derived tables from the log
pnpm db:purge --flag phase5 --yes     # privacy deletion of pre-alpha dev data (each build phase's flag)
pnpm db:latency-model --out services/agents/data/latency.json   # human timing model for agents (consented T2+ only)
pnpm db:humanlikeness                 # H per agent version (SPEC §Agents)
pnpm db:integrity pending             # flagged account seats awaiting review (also: review, restore)
pnpm consent:docs                     # regenerate docs/consent/ from the versioned consent texts
pnpm web:build && node apps/web/e2e/accounts.mjs   # browser test: real passkeys, sign-up to deletion
pnpm loadtest --store postgres        # load test, plus database-vs-log and HTTP reveal checks
TEST_DATABASE_URL=postgres://... pnpm test   # run DB tests on real Postgres (default: in-process PGlite)
```

## Layout

| Path                  | Status  | What                                                                                           |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `packages/protocol`   | built   | zod schemas: config, actions, events, per-seat views, WebSocket messages; rule constants       |
| `packages/engine`     | built   | pure deterministic rules engine (depends only on zod and protocol)                             |
| `packages/db`         | built   | migrations, match store, derived tables, reveals, accounts, trust, integrity, privacy deletion |
| `packages/bots`       | built   | scripted policies and a WebSocket bot client that plays through the public protocol            |
| `apps/server`         | built   | server-authoritative game server: matchmaking, timers, latency, logs; passkey accounts API     |
| `apps/web`            | minimal | Next.js 15 client: lobby, every prompt, chat, reveal, sign-up/sign-in, account; installable    |
| `sim/`                | built   | headless simulator and the independent log audit                                               |
| `supabase/migrations` | built   | numbered SQL migrations (`0001` match log, `0002` baseline agents, `0003` accounts/integrity)  |
| `services/agents`     | built   | Python agent service: `baseline-1` plays agent seats over the public protocol                  |

## Engine API

```ts
import { createMatch, advancePhase, applyAction, viewFor } from '@canutell/engine';

let { state } = createMatch(config, seed); // lobby; no clock, no events
({ state, events } = advancePhase(state, now)); // logs match_created, starts round 1 Invest
({ state, events } = applyAction(state, action, now)); // throws ActionRejectedError if invalid/late
({ state, events } = advancePhase(state, now)); // no-op before the deadline; resolves + timeouts after
const view = viewFor(state, seat); // the only thing a client may receive
```

- **Deterministic.** All randomness comes from a seeded sfc32 RNG stored in the state.
  `replay(config, seed, inputs)` rebuilds any match byte for byte.
- **Coin conservation** is checked after every transition. Each coin created or destroyed comes from
  a named event: `pot_multiplied`, `pot_remainder_burned`, `stake_multiplied`, `gamble_won`,
  `delay_paid`, `exile_bonus`, `ballot_scored`.
- **Every decision** is logged with `timedOut`, its option set, server timestamps and a `stateHash` of
  the exact view the seat decided from.
- **Hidden information.** Views carry no roles, agent count, others' balances, stakes, gambles, votes or
  ballots before Reveal. Tests check this by replaying identical inputs under different role layouts
  and requiring byte-identical views.

## Simulator

Each match seats four scripted policies (always-cooperate, free-rider, random, tit-for-tat). The
policies act only through their per-seat view and prompts. Every match is audited **from the event log
alone**: coin rebuild, pot math, decision completeness, timeout defaults, vote tally and exile rule,
exile bonuses, ballot payoffs, phase timing, and a role-leak scan of every view. Every 100th match also
gets a deep audit:

- a second run, compared for byte-identical replay
- schema validation of every event and view
- three counterfactual role layouts, whose views must be byte-identical

Any violation sets exit code 1.

## Server

- **Authoritative.** Clients send choices only. The server runs `applyAction`, schedules
  `advancePhase` at each deadline, and pushes each seat its own `viewFor` only when that view changed.
- **Latency** is measured on the server, from when a prompt reaches the seat's socket to when its
  choice arrives. Client timestamps are stored, never trusted.
- **Matchmaking** draws the agent count before humans gather and shows no queue counts. Parties
  (private codes) are tagged `is_party`.
- **Agent seats** are played by the Python agent service (`services/agents`) when `AGENT_SERVICE_URL` and
  `AGENT_SERVICE_SECRET` are set, over the same protocol as humans. Otherwise, or if the service fails,
  a scripted bot plays the seat and the match is flagged. Match formation takes a constant 2.5 s
  whether or not agents are seated, so its timing says nothing about the agent count.
- **Every match is logged:** meta, events, inputs, timings, connections and rejections. Matches before the
  alpha are flagged with their build phase (`phase2` to `phase5`) as non-research data. See `docs/DECISIONS.md` for the reasoning behind each choice.
- **Accounts** are passkeys only: no email, phone or birth date. A session token is re-checked in the
  database on every connection. Guests still play; each match stores a guest under a fresh pseudonym.
  No one ever sees another seat's account status.

## Data

- **Log tables are append-only:** `events`, `match_inputs`, `decision_timings`, `connections`,
  `rejections`, `client_signals`, `trust_changes` and `integrity_reviews`. A consent can only be revoked,
  once. A database trigger refuses any `UPDATE` or `DELETE`, except inside the privacy-deletion
  job.
- **Analysis tables are derived from the log** by one pure function and can be rebuilt at any time:
  `decisions`, `stakes`, `messages`, `ballots`, `seat_results` and `integrity_signals`.
- **Locked down by default:** every table has row-level security with no policies, so Supabase's public
  API keys see nothing.
- **No personal data:** players are pseudonymous `p_<uuid>` ids and chat is stored already masked.
  Identity data (user handle, passkeys, sessions, the 18+ yes/no) lives in the `identity` schema, which
  no export role can read.
- **Trust levels and consent** (SPEC §Integrity):
  - T1 means an account, T2 a confirmed 18+, T3 ten clean matches at T2+.
  - Research consent is a separate, revocable opt-in in `consents`; texts are in `docs/consent/`.
  - Automation flags (`integrity_signals`, derived at match end) lower trust by one level until a person
    reviews them. They never ban anyone.
- **The training pool** is the `training_seats` view (CLAUDE.md invariant 10). The timing model and H
  read only through it, and the `canutell_export` role can read nothing else.
