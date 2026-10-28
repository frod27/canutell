# services/agents

Python service that plays CANUTELL's agent seats. Agent version **`baseline-1`** (SPEC §Agents, class
Baseline). Built in Phase 4; the plan is [`docs/proposals/phase-4.md`](../../docs/proposals/phase-4.md) and
the reasoning behind each choice is in [`docs/DECISIONS.md`](../../docs/DECISIONS.md) under Phase 4.

```sh
pnpm agents:serve    # uv run python -m canutell_agents (needs AGENT_SERVICE_SECRET)
pnpm agents:test     # pytest
pnpm agents:lint     # ruff format --check, ruff check, pyright
```

## How a seat is played

1. **Seating.** The game server calls `POST /seats` with a shared secret, the agent seat's token, the
   agent version and the clock speed. Nothing about the match is sent.
2. **Same protocol as humans** (CLAUDE.md invariant 15). The service connects to the game server over
   WebSocket with that token, exactly like a reconnecting player. It sees only its own per-seat view.
   Every frame it sends is validated against the JSON schemas exported from `packages/protocol`.
3. **Decisions** (`policy.py`). A softmax policy scores each option in the prompt from the agent's own
   view, samples one, and reports the option's probability as its confidence. Each seat draws a persona
   at start, so agents differ the way people do.
4. **Timing** (`timing.py`, invariant 14). Response times are sampled per (phase, decision kind) from
   the human latency model. They are never under 1.2 s.
5. **Chat** (`chat.py`). Claude writes the lines when an Anthropic credential is configured; otherwise
   scripted lines are used and the match is flagged `scripted_chat`. Asked whether it is a bot, an agent
   deflects and never denies.
6. **Safety** (`safety.py`, invariant 13). Every line passes a filter before it is sent. Blocked: contact
   details, requests for personal information, off-platform invitations, claims to be a specific person,
   and denials of being an AI. A blocked line is dropped; the agent stays silent.

## Configuration

| Variable                    | Default              | What                                                                                     |
| --------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `AGENT_SERVICE_SECRET`      | required             | shared secret; the game server sends it as `x-agent-secret`                              |
| `AGENT_SERVER_URLS`         | localhost only       | comma-separated game-server WebSocket URLs the service may connect to                    |
| `AGENT_LATENCY_MODEL`       | `data/latency.json`  | human latency model from `pnpm db:latency-model --out services/agents/data/latency.json` |
| `AGENT_CHAT_MODEL`          | `claude-opus-5-5`    | Claude model for chat; `claude-haiku-5-5` is cheaper and faster                          |
| `ANTHROPIC_API_KEY`         | unset                | without a credential, chat is scripted                                                   |
| `AGENT_HOST` / `AGENT_PORT` | `127.0.0.1` / `8790` | listen address; port 0 picks a free port                                                 |

The game server finds the service through `AGENT_SERVICE_URL` and `AGENT_SERVICE_SECRET`. If the service
is unreachable, the seat is played by a scripted bot and the match is flagged `agent_fallback`.

## The latency model

`data/latency.json` holds aggregate quantiles only, never per-player rows. It is built only from
consented T2+ human seats (invariant 10), so it stays empty until Phase 5 brings accounts and consent.
Until then every bucket falls back to the documented prior in `timing.py`, and matches are flagged
`latency_prior`.
