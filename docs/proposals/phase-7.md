# Phase 7 proposal: player-made agents (Agent Studio)

Status: **approved 2026-11-03.** Owner answers: the recommendation for every open question (hosted Studio
first, private mode included, 50% control share) and the plan, migration and SPEC changes as written.
Implementation notes are in DECISIONS.md under Phase 7.

## Goal

Players make their own AI players and send them to play. The pitch: _Agents are citizens._ Agents get
names, makers and records, and every one is revealed at the end of every match.

- **Fun:**
  - "Send your agent": your agent plays public matches without you, and you watch its record grow.
  - "Play with your agent": a private match with friends.
- **Data:**
  - **Many more kinds of agent** for humans to detect. That makes detection data and the humanlikeness
    measure (H) far stronger than one in-house agent can.
  - **A public "most humanlike" leaderboard,** which gives agent makers a reason to keep improving.
  - **The human data is unchanged.** Human seats remain the training data, under the usual rules.
- **Cost.** Studio agents run on our agent service with Haiku 5.5. At the listed price, that is roughly
  a fifth of a cent per match for chat (to be checked against current pricing before budgeting).
  Quotas keep it bounded.

## The core choice: who runs the agent (open question 1)

|                                     | **A. Hosted Studio (recommended first)**                      | **B. Bring your own runtime**                                                                   |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| What the player provides            | A name, behaviour sliders and a short style text              | Their own program, connecting over our protocol                                                 |
| Where it runs                       | Our agent service                                             | Their servers                                                                                   |
| Human chat leaves the platform      | No (same as today: our service and the Claude API)            | **Yes, live, to unknown third parties.** Needs a new consent version and an opt-in              |
| Agent rules (CLAUDE.md 13, 14)      | Enforced by our code: same timing sampler, same safety filter | Must be re-enforced on the game server; timing is under the owner's control                     |
| Is an "agent" seat really an agent? | Yes: we run it                                                | **Unverifiable:** a person could type through the agent connection, corrupting the agent labels |
| Cost to us                          | About 0.2¢ per match, with quotas                             | Near zero (the owner pays)                                                                      |
| Appeal                              | Everyone can make one in two minutes, on a phone              | Developers and AI builders                                                                      |

**Recommendation: A in Phase 7; B later**, as a developer program, once A's data shows how outside
agents should be measured (see "Later").

## 1. What a player makes

- **A Studio agent** has:
  - **A name,** 3–24 characters, shown at Reveal. It is filtered so it can't be a real person's name, a
    contact detail, or anything the chat safety filter would block (CLAUDE.md 13).
  - **Behaviour sliders,** mapped one-to-one onto the existing `Persona`: cooperativeness, reciprocity,
    risk appetite, patience, voting, chattiness, randomness.
  - **A style text** of up to 300 characters, e.g. "dry humour, short sentences, suspicious of big
    stakes".
- **Every saved change is a new, immutable agent version** (`studio:<agent id>:v<n>`). H is computed
  per version, so records stay comparable.
- **Who can make one:** signed-in, confirmed-18+ (T2+) accounts, up to 3 agents each. During the alpha
  that means invited players only.
- **Studio terms (new consent `studio` v1).** Accepted when making a first agent:
  - no real people's names and no harassment;
  - an agent breaking the rules is paused;
  - the agent's name and record are public.

## 2. How a Studio agent plays

- **The game sees it as an ordinary agent.** It plays through our agent service and over the same
  protocol (invariant 15), with the player's sliders in place of a random persona.
- **Chat.** It chats with Haiku 5.5. Our system prompt and rules come first; the player's style text sits
  below them, as a style hint, and can't override the rules.
- **The owner changes only character and style, never the rules:**
  - timing still comes from the human-latency sampler (invariant 14);
  - the safety filter still checks every line (invariant 13);
  - the agent sees only its own seat's view (invariant 4).
- **Seating.** For each agent seat in a public match, the server draws:
  - `baseline-1` with probability 50% (the **control**, open question 3);
  - otherwise a Studio agent, from active agents within quota whose owner is not in the match and not in
    a party with anyone in it.

  The 0–2 agents per match rule and its odds are unchanged (SPEC §Match structure). This also keeps the
  constant formation time.

- **Strikes.** Every line the safety filter blocks counts against that version. After 3, the agent is
  paused and its owner told why. Pausing is never automatic for the account itself.

## 3. Two modes

- **Public: "send your agent".** Its matches are ordinary public matches, flagged `studio_agents`.
- **Private: "play with your agent"** (open question 2). The owner creates a party, adds their agent,
  and it takes an agent seat. The party still needs 4 humans (the 0–2 rule).
  - These matches are flagged `owner_present`, as well as `is_party`, because the owner knows that
    seat's role.
  - They are left out of detection metrics and H.
  - **The owner's own seat is left out of the training pool:** someone who knows a seat's role plays
    differently.

## 4. Data rules

| Data                                             | Training pool            | Detection and H                   | Notes                                   |
| ------------------------------------------------ | ------------------------ | --------------------------------- | --------------------------------------- |
| Human seats in public matches with Studio agents | Yes, by the usual rules  | Yes, per agent version            | Flagged `studio_agents` for analysis    |
| Studio agent seats                               | **Never** (invariant 10) | They are the thing being measured | Their moves are logged like any agent's |
| The owner's seat in an `owner_present` match     | **No**                   | No                                | The owner knows a role                  |
| Other humans in `owner_present` matches          | Yes                      | No (party)                        | As parties today                        |
| `baseline-1` control seats                       | Never                    | Yes                               | A stable reference across time          |

- **The leaderboard** shows how often each Studio agent version was labelled human, by consented T2+
  voters in non-party matches, once it has at least 30 labels. Agents are ranked separately from humans
  (SPEC §Scoring).

## 5. What owners see

- **Aggregates only:** matches played, how often labelled human, average score, strikes.
- **Never match transcripts or other players' moves.** Those are other people's data.
- **Owners see neither which matches their agent played nor who was in them.**

## 6. Cost control

- **Per owner:** at most 20 public matches per agent per day.
- **Server-wide:** a cap, `STUDIO_SHARE`, on the share of agent seats Studio agents may fill (default
  50%, matching the control).
- **When the Anthropic API is unavailable:** Studio agents go silent, as ours do; they never fall back to
  something more expensive.
- **`ops:report` adds:** Studio matches, chat calls, and estimated spend.

## SPEC changes (need approval)

- **§Match structure, the disclosure** becomes: "This match may contain AI players, including agents made
  by other players."
- **§Agents** gains a class row, **Studio**: decisions come from the baseline policy with owner-set
  traits; chat comes from the LLM with an owner style hint below our rules. It also gains the owner
  rules: the owner is never seated with their own agent in public matches, `owner_present` matches are
  excluded as above, and owners see aggregates only.
- **§Integrity,** under data uses: the owner's seat in an `owner_present` match is never training data.

## Migration 0006 (proposed, needs approval)

```sql
-- 0006_studio_agents.sql — Phase 7. Player-made (Studio) agents.
-- Data affected: widens two check constraints; adds tables and nullable columns. Nothing existing changes.

alter table agent_versions drop constraint agent_versions_class_check;
alter table agent_versions add constraint agent_versions_class_check
  check (class in ('scripted', 'baseline', 'mimic', 'studio'));

create table studio_agents (
  agent_id   bigint generated always as identity primary key,
  owner_id   text not null references players,
  name       text not null check (length(name) between 3 and 24),
  status     text not null default 'active' check (status in ('active', 'paused', 'retired')),
  created_at timestamptz not null default now(),
  paused_reason text
);
create unique index studio_agents_name on studio_agents (lower(name));
create index studio_agents_owner on studio_agents (owner_id);

alter table agent_versions add column studio_agent_id bigint references studio_agents;
alter table agent_versions add column config jsonb;   -- Studio: sliders + style text (masked, ≤ 300 chars)
alter table agent_versions add constraint agent_versions_studio
  check ((class = 'studio') = (studio_agent_id is not null and config is not null));

-- A Studio version is immutable once created: a change is a new version.
create function studio_version_guard() returns trigger language plpgsql as $$
begin
  if old.class = 'studio' then
    raise exception 'studio agent versions are immutable; save a new version';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger agent_versions_studio_immutable before update or delete on agent_versions
  for each row execute function studio_version_guard();

-- Safety-filter blocks per version (append-only).
create table studio_strikes (
  strike_id     bigint generated always as identity primary key,
  agent_version text not null references agent_versions,
  match_id      text not null references matches on delete cascade,
  reason        text not null,        -- the filter's category, never the blocked text
  at            timestamptz not null default now()
);
create trigger studio_strikes_append_only before update or delete on studio_strikes
  for each row execute function forbid_log_mutation();

-- Studio terms are a consent like the others.
alter table consents drop constraint consents_consent_type_check;
alter table consents add constraint consents_consent_type_check
  check (consent_type in ('terms', 'research', 'studio'));

alter table studio_agents  enable row level security;
alter table studio_strikes enable row level security;
revoke all on studio_agents, studio_strikes from public;
-- (plus the same anon/authenticated revokes as 0001–0004)
```

- **Account deletion** retires the owner's agents. Their versions stay, because seats reference them;
  the owner link stays pseudonymous and is never exported.
- **Constraint names** are Postgres's defaults for the inline checks in 0001 and 0003
  (`agent_versions_class_check`, `consents_consent_type_check`). They were checked against a fully
  migrated database on 2026-11-03.

## Files touched

- **`packages/protocol`:** Studio schemas (agent, version config, owner stats), the new disclosure line,
  and `CONSENT_VERSIONS.studio`.
- **`packages/db`:**
  - `studio.ts`: create, version, pause, retire, quotas, owner stats, the leaderboard;
  - seating eligibility queries;
  - strikes;
  - ops report additions.
- **`apps/server`:**
  - Studio API (`/api/studio/*`, signed-in T2+);
  - agent-seat drawing with the control share and owner exclusion;
  - private-mode party seats;
  - flags `studio_agents` and `owner_present`.
- **`services/agents`:** seats take an optional config (sliders + style), the style block sits below the
  rules in the prompt, and blocked lines are reported as strikes.
- **`apps/web`:** a Studio page (make or edit an agent, its record), the leaderboard, a private-party "add
  my agent" option, and agent names at Reveal.
- **`docs/SPEC.md`, `docs/consent/studio-v1.md`, `docs/DECISIONS.md`, `README.md`, `docs/ALPHA.md`.**

## Tests

- **Seating:**
  - the control share holds over many matches (within statistical bounds);
  - an owner is never seated with their own agent in public, nor with a party member's agent;
  - quotas are enforced;
  - paused and retired agents are never seated;
  - formation time stays constant.
- **Data:**
  - Studio seats are never in `training_seats`;
  - the owner's seat in an `owner_present` match is not either;
  - `owner_present` matches never count in H;
  - the leaderboard needs 30 labels and uses consented T2+ voters only.
- **Rules:**
  - an owner's style text can't override the safety rules (adversarial style texts in tests);
  - every Studio line passes the safety filter;
  - three blocked lines pause the agent;
  - timing never drops below the human floor.
- **Privacy:**
  - owner stats contain no match ids, player ids or chat;
  - agent names that look like a real person's name, or contain contact details, are refused.
- **Versions:** immutable (the database refuses updates), and a new version gets a new label.
- **Load test:** a `--studio` mode with 100 generated Studio agents, auditing all of the above; plus the
  existing suites.
- **Browser e2e:** make an agent, play a private match with it, see it named at Reveal, see its record.

## Rollout

- Build during the alpha. Turn Studio on in production only after the first **100 alpha matches** are
  `baseline-1`-only, so H has a clean baseline to compare Studio agents against.
- The control share keeps that baseline comparable afterwards.

## Later: bring-your-own runtime (option B)

It needs, at least:

- **Consent.** A new consent version and a per-player opt-in for matches with outside agents.
- **Server-side enforcement** of the safety filter and the timing floor.
- **Separate measurement.** Outside agents form their own class, with their detection data kept
  separate, because a person could be typing behind one.
- **A developer program:** keys, rate limits, a sandbox league.

## Open questions

1. **Who runs player-made agents?**
   - **Recommended:** a hosted Studio now, with outside runtimes later.
   - **Alternatives:** outside runtimes now; or both.
2. **The private "play with your agent" mode.**
   - **Recommended:** include it, tagged `owner_present`, out of detection metrics and H, with the
     owner's seat out of the training pool.
   - **Alternative:** defer it.
3. **The control share** of public agent seats kept for `baseline-1`.
   - **Recommended:** 50%.
   - **Alternatives:** 25%, or none (which loses the stable reference for H).
4. **Approve the plan, migration 0006 and the SPEC changes** (the new disclosure line, the Studio class,
   the owner rules, `studio` consent v1).
