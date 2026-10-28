# CANUTELL

A browser-first social deduction game: six seats, 0–2 of them secretly AI agents. Players invest, deal,
gamble and vote, then label every other player as human or agent. Rules and data schema:
[`docs/SPEC.md`](docs/SPEC.md). Build contract: [`CLAUDE.md`](CLAUDE.md). Decisions:
[`docs/DECISIONS.md`](docs/DECISIONS.md).

**Current phase: 2 — real-time loop** (Phase 1, engine + simulator, is complete).

```sh
pnpm install
pnpm test                                    # all unit + integration tests
pnpm sim --matches 10000 --mode full         # engine simulator (also --mode quick | both)
pnpm loadtest --matches 200 --mode both      # real matches over WebSockets, fully audited
pnpm typecheck && pnpm lint && pnpm format:check
```

Play locally:

```sh
pnpm serve:dev     # game server on :8787; fills empty seats with bots after 5 s (dev only)
pnpm web           # web client on http://localhost:3000
```

`pnpm serve` runs the server without bot fill. It is configured by environment variables (`PORT`,
`DATA_DIR`, `CLOCK_SPEED`, `FILL_BOTS_MS`, `AGENT_WEIGHTS`; see `apps/server/src/main.ts`). Match logs go
to `data/matches/<matchId>/` as append-only JSONL. The web client connects to `NEXT_PUBLIC_SERVER_URL`,
or to port 8787 on the page's host.

## Layout

| Path                                     | Status       | What                                                                                          |
| ---------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `packages/protocol`                      | built        | zod schemas: config, actions, events, per-seat views, WebSocket messages; rule constants      |
| `packages/engine`                        | built        | pure deterministic rules engine (depends only on zod and protocol)                            |
| `packages/bots`                          | built        | scripted policies and a WebSocket bot client that plays through the public protocol           |
| `apps/server`                            | built        | server-authoritative game server: sessions, matchmaking, parties, timers, latency, JSONL logs |
| `apps/web`                               | minimal      | Next.js 15 client: lobby, every prompt, chat, reveal; installable                             |
| `sim/`                                   | built        | headless simulator and the independent log audit                                              |
| `services/agents`, `supabase/migrations` | placeholders | Phases 4 and 3                                                                                |

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
  (private codes) are tagged `is_party`. Agent seats are filled by scripted bots over the same protocol
  until Phase 4.
- **Every match is logged:** meta, events, inputs, timings, connections and rejections. Phase 2 matches
  are flagged as non-research data. See `docs/DECISIONS.md` for the reasoning behind each choice.
