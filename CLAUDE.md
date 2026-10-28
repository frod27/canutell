# CANUTELL — Build Contract

CANUTELL is a browser-first social deduction game. Six seats, 0–2 of them secretly AI agents. Players invest, deal, gamble and vote, then label every other player as human or agent.

**The product's purpose is data.** Every match produces clean, consented behavioral data, and that data trains agents that get harder and harder to tell from people. Fun is how the game earns players. When a design choice trades data quality against convenience, data quality wins. Flag the tradeoff instead of silently picking convenience.

The full rules and data schema live in `docs/SPEC.md`. It is the source of truth. If code and SPEC disagree, SPEC wins. If SPEC is ambiguous or wrong, stop and ask. Don't guess.

## Architecture

pnpm monorepo:

```
packages/engine/     Pure TypeScript rules engine. No I/O, no clock, no network.
packages/protocol/   Shared types: events, messages, client/server payloads (zod schemas).
apps/server/         Server-authoritative Node game server. WebSockets, matchmaking, timers.
apps/web/            Next.js 15 + TypeScript client. Mobile-first. Installable as a home-screen app.
services/agents/     Python service. Baseline and Mimic agents. Talks to the server like a player.
supabase/migrations/ Postgres schema. Every change is a numbered migration.
sim/                 Headless simulator: runs thousands of bot-only matches through the engine.
docs/                SPEC.md (rules + schema), DECISIONS.md (decision log).
```

Hosting: `apps/web` can deploy to Vercel. `apps/server` needs long-lived WebSocket connections, so it runs on a host that supports persistent processes, not serverless functions.

## Non-negotiable invariants

### Engine
1. **Deterministic.** Same seed + same inputs = identical match, byte for byte. All randomness goes through one seeded RNG passed in, never `Math.random()`.
2. **Pure.** The engine takes state + action and returns new state + events. No clock, no I/O. Time arrives as an input.
3. **Integer coins.** All coin math is integer. Rounding rules are in SPEC §Coin math. Coin conservation is checked after every transition: every coin created or destroyed is accounted for by a named event.
4. **Hidden information stays hidden.** The engine produces a per-seat view. A seat's view never contains other seats' private contributions, stakes in flight to others, roles, or ballots.

### Server
5. **Server-authoritative.** Clients send choices only. The server validates every action against the engine and rejects anything invalid or late.
6. **Latency is measured on the server**, from the moment a phase prompt is sent to a seat until its choice arrives. Client timestamps are stored separately and never trusted.
7. **Roles are never sent to a client before the match-end reveal.** That includes the agent count, exiled players' roles, and anything derivable from them.

### Data
8. **Append-only event log.** Every state change emits a typed event with a server timestamp and match sequence number. Derived tables are rebuilt from the log. Events are never edited or deleted, except by the privacy-deletion job.
9. **No personal data in events or derived tables.** Players are pseudonymous IDs. Email, phone and verification data live only in `identities`, which is never joined into training exports.
10. **Agent seats never enter the training pool.** Training exports select only seats where `is_agent = false`, `trust_level >= T2`, and the player has active research consent at export time.
11. **Party matches are tagged** (`is_party = true`) and excluded from detection metrics.
12. **Coins have no cash value.** No feature may let coins be bought, sold, transferred outside a match, or cashed out.

### Agents
13. Agents follow the rules in SPEC §Agents. They never claim to be a specific real person, never ask for personal information, and never invite anyone off-platform.
14. Agent response timing is sampled from the human latency distribution for that phase. Never instant.
15. Agents connect to the server through the same protocol as humans. No back channel to hidden state.

### Monetization
16. Only cosmetics and a season pass. Nothing sold may change payoffs, information or odds.

## How to work

- **Plan before code.** For any task beyond a small fix, write a short plan (files touched, tests to add, open questions) and wait for approval.
- **Tests first for the engine.** Every rule in SPEC gets a unit test that cites the SPEC section. The simulator must run 10,000 seeded matches with zero invariant violations before any UI work depends on a rule change.
- **Small, reviewable changes.** One concern per change. Keep the engine package free of dependencies beyond zod.
- **Schema changes need approval.** Propose the migration, explain what data it affects, and wait.
- **Log decisions.** When you resolve an ambiguity (with the user's answer), add a dated entry to `docs/DECISIONS.md`: the question, the decision, the reason.
- **Don't widen scope.** If you notice something worth building that isn't in the current phase, note it in `docs/DECISIONS.md` under "Later" and keep going.
- **Stack defaults:** TypeScript strict mode, zod at every boundary, Vitest for TS tests, pytest for Python, ESLint + Prettier. Supabase for Postgres and auth (passkeys preferred).

## Build phases

1. **Engine + simulator.** Rules engine with tests; simulator running bot-only matches and printing payoff and invariant reports.
2. **Real-time loop.** Lobbies, matchmaking, timers, WebSocket protocol, per-seat views.
3. **Event log + schema + reveal screen.**
4. **Baseline agents** with human-like timing.
5. **Accounts, trust levels, consent flows, integrity signals.**
6. **Closed alpha** with 30–50 players. Fun first, data second.

Work only on the current phase unless told otherwise. The current phase is stated in each session's kickoff message.
