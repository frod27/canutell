# CANUTELL

A browser-first social deduction game: six seats, 0–2 of them secretly AI agents. Players invest, deal,
gamble and vote, then label every other player as human or agent. Rules and data schema:
[`docs/SPEC.md`](docs/SPEC.md). Build contract: [`CLAUDE.md`](CLAUDE.md). Decisions:
[`docs/DECISIONS.md`](docs/DECISIONS.md).

**Current phase: 1 — engine + simulator.**

```sh
pnpm install
pnpm test                                    # all unit + integration tests
pnpm sim --matches 10000 --mode full         # also: --mode quick | both, --seed, --timeout-pct, --json
pnpm typecheck && pnpm lint && pnpm format:check
```

## Layout

| Path                                                                | Status       | What                                                                       |
| ------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `packages/protocol`                                                 | built        | zod schemas: match config, actions, events, per-seat views; rule constants |
| `packages/engine`                                                   | built        | pure deterministic rules engine (only depends on zod + protocol)           |
| `sim/`                                                              | built        | headless simulator, bot policies, independent log audit                    |
| `apps/server`, `apps/web`, `services/agents`, `supabase/migrations` | placeholders | later phases                                                               |

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
