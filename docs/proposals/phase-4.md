# Phase 4 proposal: Baseline agents with human-like timing

Status: **approved 2026-10-28 and implemented.** Owner answers: deflect, never deny; Claude chat with a
scripted fallback; placeholder timing prior; migration 0002 as written. The shipped migration differs
only in the `chat_model` description of `baseline-1` (see DECISIONS.md "Chat model"). Results are in
DECISIONS.md "Phase 4 acceptance results".

## Goal

A `baseline-1` agent (SPEC §Agents, class Baseline) that plays real matches in agent seats. It:

- **plays through the public protocol only** (CLAUDE.md invariant 15)
- **decides with a fast decision model** that picks from each prompt's option set and reports a
  confidence
- **chats through an LLM** with a persona and style guide
- **responds on a human timing distribution, never instantly** (invariant 14)
- **follows the agent rules**: never claims to be a real person, never asks for personal information,
  never invites anyone off-platform (invariant 13)

The Phase 2 TypeScript bots remain as `scripted-0`, the fallback whenever the agent service is
unavailable.

## Architecture

**`services/agents/`: Python 3.13** (as CLAUDE.md specifies), managed with `uv`. Tested with pytest;
linted with ruff and pyright.

- **Protocol contract.**
  - Zod stays the single source of truth. `pnpm protocol:schema` exports JSON Schema for every client
    and server frame into `packages/protocol/schema/`, committed.
  - The Python service validates every frame it receives _and_ sends against that schema.
  - A test fails if the committed schema is stale, and shared fixture frames must validate in both
    languages.
- **Seating.**
  - When a match forms, the server asks the agent service for each agent seat: `POST /seats` with
    `{serverUrl, token, agentVersion}`, authenticated by a shared secret.
  - Nothing about the match is sent. The service then connects over WebSocket with that token,
    exactly like a reconnecting player.
  - If the service is unhealthy at formation time, the seat gets a `scripted-0` bot instead, and the
    stored `agent_version` says so honestly.
- **Isolation.** Each seat is an independent `AgentSession` with its own RNG and memory. The service
  never indexes sessions by match, so two agents at one table cannot learn about each other. Learning
  that would be a back channel to the agent count (invariant 7). A test asserts sessions share no
  mutable state.

**Decision model (`baseline-1`).**

- **How it chooses:** a stochastic policy per prompt kind. It takes a softmax over option utilities
  computed from features of the agent's own view only:
  - balance and round
  - revealed contributions (individual mode) or pot share (aggregate mode)
  - reciprocity history with each seat
  - exiles so far
  - its own pending delays
- **Per-seat persona:** parameters drawn when the session starts (cooperativeness, reciprocity, risk
  appetite, vote propensity, chattiness), so agents differ from one another the way people do.
- **Confidence:** the softmax probability of the chosen option.
- **Determinism:** given its seed, the policy is deterministic, which makes it testable.
- **Ballot:** suspicion scores from observable behavior produce labels and confidences. Agent ballots
  are logged but never scored (SPEC).

**Chat.**

- **Model:** an LLM with a persona and a style guide: short, casual, game-only talk.
- **Input:** only the agent's own view, meaning table chat, its own DMs and public results.
- **Safety, two layers (invariant 13):**
  1. _System-prompt rules._
  2. _A deterministic output filter_ that drops any message which contains contact details or links
     (the engine's masking patterns, ported), asks for personal information, invites anyone
     off-platform, or claims to be a specific real person.
- **On a filter hit:** the message is dropped, the agent stays silent rather than retrying, and the drop
  is counted. A corpus of should-block and should-pass messages is tested.

**Timing (invariant 14).**

- **Source:** decision latencies are sampled per (phase, decision kind) from the empirical human
  distribution. Eligible timings come from `decision_timings` where all of these hold:
  - the seat is human
  - the match is not flagged `bot_fill` or `sped_up`
  - the prompt was seen
  - the decision did not time out
- **Export:** `pnpm db:latency-model` exports only aggregate quantiles, with no per-player rows, to
  `services/agents/data/latency.json`.
- **When it starts:** the sample starts when the prompt is delivered (the server's definition of
  latency).
- **Bounds:** never below the human minimum for that bucket, and always clipped to land before the
  deadline.
- **Chat timing:** reading time plus typing time, sampled the same way from human `typing_ms` (which is
  client-reported, so it is only a rough guide).

## Server changes

- An agent-service client sends the seat requests, with the `scripted-0` fallback.
- `AGENT_SERVICE_URL` and `AGENT_SERVICE_SECRET` configure it.
- **Agent confidence on actions.** Action frames gain an optional `confidence` (0–1).
  - It is accepted only from agent seats; a human client sending it is rejected as an invalid frame.
  - It is stored in the new `agent_annotations` table (migration 0002).
  - `decisions.confidence` is derived from it.

## Proposed migration `0002_baseline_agents.sql`

**What data it affects:**

- It adds one reference row (`baseline-1`) and one append-only table holding agent-only data.
- **Human data:** none is touched.
- **Personal data:** none.
- **Training pool:** agent seats never enter it (invariant 10), so this table is never exported for
  training.

```sql
insert into agent_versions (agent_version, class, decision_model, chat_model, released_at)
  values ('baseline-1', 'baseline', 'softmax policy over view features, v1', '<chat model id>', now());

-- Agent-reported confidence per decision (SPEC §Agents: "picks … with a confidence").
create table agent_annotations (
  match_id   text not null references matches on delete cascade,
  seq        integer not null,                       -- the decision event's seq
  seat_id    smallint not null check (seat_id between 0 and 5),
  confidence smallint not null check (confidence between 0 and 100),  -- percent, as decisions.confidence
  primary key (match_id, seq)
);
create trigger agent_annotations_append_only before update or delete on agent_annotations
  for each row execute function forbid_log_mutation();
alter table agent_annotations enable row level security;
```

`derive()` then fills `decisions.confidence` from `agent_annotations`. The column already exists, and it
stays null for human seats.

## Tests and acceptance

- **Python unit tests:**
  - every prompt kind yields only legal choices, property-tested over recorded views
  - confidence is in [0, 1]
  - the policy is deterministic per seed
  - the safety-filter corpus blocks and passes as expected
  - the latency sampler matches its source distribution (KS test) and never answers instantly
  - every frame is validated against the schema
  - sessions are isolated
- **LLM tests:** run against a fake LLM. One opt-in live smoke test runs only when an API key is set.
- **Acceptance:** `pnpm loadtest --agents python` must finish with 0 violations, with the service
  playing every agent seat over real sockets. It checks everything the Phase 3 load test checks, plus:
  - every agent decision has a latency at or above the human minimum for its bucket
  - every agent chat message in the log passes the safety filter
  - rejections are only `late`
  - `agent_version = baseline-1` is recorded
- **Not testable yet:** humanlikeness H needs human ballots (closed alpha, Phase 6). I'll add the
  query that computes it, which excludes party and dev-flagged matches, but it will report "no data"
  until then.

## Open questions (decisions needed)

1. **What an agent says when asked "are you a bot?"**
   - **Context:** the lobby discloses that AI players may be present, and roles are revealed at the end,
     so the question is a game move.
   - **Recommendation:** deflect playfully ("that's exactly what a bot would ask", "you'll find out at
     the reveal"). Never flatly claim to be human and never deny being an AI. Break character if a
     player seems sincerely confused or distressed rather than playing.
   - **Alternatives:**
     - allow in-character claims of being human: more realistic, but outright deception
     - admit it whenever asked: honest, but it breaks the game
2. **The chat LLM.**
   - **Recommendation:** build on the Anthropic API with a fast Claude model, with scripted chat lines
     as a fallback when no key is configured. Matches using the fallback are flagged `scripted_chat`.
   - **Needed from you:** this environment has no `ANTHROPIC_API_KEY`. Do you have one to add, or
     should Phase 4 ship with scripted chat only for now?
3. **Timing before there is human data.**
   - **Context:** every timing recorded so far comes from bots and test runs. There are 0 genuine
     human samples.
   - **Recommendation:** use a documented placeholder prior until each (phase, kind) bucket has at
     least 200 real human samples, and flag matches that used it `latency_prior`. Real data replaces
     the prior automatically once the closed alpha produces it.
   - **Alternative:** hold agents back until the data exists, which means no agents before Phase 6.
4. **Migration 0002** as written above.
