# CANUTELL — Decision log

Each entry records a question, the decision and the reason. Entries marked **[user]** were decided by the
project owner. Entries marked **[engine]** are implementation interpretations that do not change a rule
as written; they are listed so they can be reviewed and overturned. Entries marked **[data tradeoff]**
pick between data quality and convenience and say which way they went.

---

## 2026-10-28 — Phase 1 (engine + simulator)

### Ballot payoff at 50/50 [user]

- **Question.** SPEC §Scoring gives `B = 40 × (0.75 − (q − y)²)` and says the range is "+30 for a certain
  correct label, −10 for a certain wrong one, 0 at 50/50". The formula gives **+20** at q = 0.5 for either
  label, not 0. No symmetric, strictly proper rule can hit all three values: with G convex, G(½) = 0 and
  G(0) = G(1) = 30 force G′(0) ≤ −60, but S(0, 1) = G(0) + G′(0) = −10 needs G′(0) = −40.
- **Decision.** Keep the formula exactly. +30 / −10 / **+20 at confidence 50**. The "0 at 50/50" text is
  the error. A blank label still scores 0.
- **Reason.** The formula is the strictly proper part, and properness is what makes confidence honest.
  Side effect: a 50% label strictly beats a blank (+20 vs 0), so players are pushed to fill every
  label, which means more ballot data.
- **Follow-up.** Done: SPEC §Scoring now says +20 at 50/50 and notes the rounding caveat. Integer
  rounding makes the rule only _approximately_ proper: the honest report is within 1 coin per label of
  the best expected payoff (tested in `coin-math.test.ts`). The unrounded rule is exactly proper.

### Exile bonus counts successful exiles only [user]

- **Question.** "+10 for each human who voted to exile a seat that turned out to be an agent, −5 for voting
  to exile a human." Does every vote count, or only votes for the seat that was actually exiled?
- **Decision.** Only votes for the seat actually exiled that round. Votes for seats that were not exiled
  score nothing. Agent voters never get the bonus or the penalty.
- **Reason.** It matches the name "exile bonus" and rewards the coordinated act, not the cheap signal.

### Vote visibility before Reveal [user]

- **Decision.** Views show only the outcome of each vote (exiled seat or nobody). Tallies and who voted for
  whom stay hidden until Reveal, where both appear.
- **Reason.** It keeps later votes and ballots uncontaminated, the same reasoning SPEC §Vote gives for
  hiding exiled roles.

### Chat window [user]

- **Question.** SPEC §Deal says chat "runs throughout". Throughout the Deal, or throughout the match?
- **Decision.** Chat is open in every phase from round 1 Invest through Final ballot, and closes at
  Reveal.
- **Reason.** Players can discuss votes and ballots, and it yields more chat data.

### Pot accounting [engine]

- The per-player payout is SPEC's `floor(P × 16 / (10n))` verbatim. SPEC's remainder phrase
  ("P − n × payout_share_of_P") is not integer-defined, so the accounting is:
  - `G = floor(16P/10)`, the integer grown pot.
  - `pot_multiplied.created = G − P`, which equals `floor(6P/10)`.
  - `pot_remainder_burned.destroyed = G − n × share`.
- Because `floor(floor(x)/n) = floor(x/n)`, `share = floor(G/n)`, so `0 ≤ burned < n`. The fractional
  part of 0.6P is never created, so it never needs to be burned. Payouts are unchanged.

### Stakes and returns are capped at balance [engine]

- A stake is 1–20 coins **and** at most the sender's balance. A return is 0–2s **and** at most the
  receiver's current balance. This mirrors SPEC §Invest's "capped at their balance" and keeps balances
  non-negative.
- The decision's `optionSet.max` records the cap actually offered, so analysis can tell "returned
  little" from "could not return more".

### Stakes arrive immediately [engine]

- The stake is debited, doubled (`stake_multiplied`) and credited in one transition. The return window
  opens at once.

### Deliberate defaults are distinct from timeouts [engine, data tradeoff → data]

- Every default has a deliberate counterpart: invest 0, a stake pass `{to: null, amount: 0}`, a return
  of 0, gamble A, a vote skip `{target: null}`, and a ballot with labels left out. Each is logged as a
  decision with `timedOut = false`. Timeouts log the same `chosen` value with `timedOut = true`, stamped
  at the deadline.
- SPEC §Match structure requires analysis to tell a deliberate 0 from a timeout. The stake pass and
  vote skip are actions SPEC implies but doesn't name.

### One submission per decision [data tradeoff → convenience, flagged]

- Each decision (invest, stake, gamble, vote, ballot, each return) is final once submitted. A second
  submission is rejected with `already_acted`.
- **Tradeoff.** We lose "changed my mind" signals, which are useful for hesitation and deliberation. In
  exchange each decision has exactly one choice and one latency. Revisions are listed under "Later".

### Phases always run their full duration [engine, data tradeoff → data]

- No phase ends early when everyone has acted. This matches SPEC's 11.5 min and 7 min totals (690 s and
  420 s, both tested). It also keeps phase length and the latency distribution comparable across
  matches, and doesn't leak "everyone else has already chosen".

### Late timers [engine]

- If the server calls `advancePhase` after the deadline, timed-out decisions get `decidedAt = deadline`
  while event `serverTs` is the actual call time. The next phase starts at the actual call time and gets
  its full duration.

### Return decisions log the phase they happened in [engine]

- A return can happen in any phase before its deadline. Its decision event carries the round and phase
  in which it was made, plus `optionSet.stakeId`. The stake's own round is in `stake_sent`. A return
  that times out is logged at the end of the deadline Deal.

### Agent seats' scoring [engine]

- SPEC §Final ballot: agents' ballots "are logged but never scored for humans". SPEC §Scoring: the exile
  bonus is "for each human who voted".
- **Decision.** Agent ballots are logged and their payoff is computed (`ballot_scored.applied = false`,
  shown at Reveal), but no coins move. Agents get no exile bonus. An agent's final score is coins plus
  delayed gamble payouts. Agents are ranked separately (SPEC), so this affects only agent leaderboards.

### Negative final scores [engine]

- Ballot penalties and the −5 exile penalty are applied at Reveal and may take a final score below 0
  (e.g. 0 coins and four certain wrong labels gives −40). Balances can never be negative before Reveal,
  and the engine enforces that after every transition.

### What a seat can see [engine]

These follow from CLAUDE.md invariants 4 and 7.

- **Other players' balances are hidden.** They would leak private stakes, returns and gamble outcomes.
- **Individual reveal mode** shows every active seat's contribution after Invest, a timed-out
  contribution as 0, and never who timed out. **Aggregate mode** shows the pot total and per-player
  share.
- **Exiled seats** can read table chat but post only in the exile channel. Only exiled seats can read
  the exile channel. DMs are only between active players.
- **Chat messages carry no global index or sequence number.** That would reveal how many DMs or exile
  messages the seat can't see. A DM between two other seats leaves a third seat's view byte-identical
  (tested).
- **The reveal mode itself is public.** Players need to know what they'll see.
- A test runs identical inputs under five different role layouts (0, 1 and 2 agents) and asserts the
  views are byte-identical until Reveal. The simulator repeats this as a counterfactual audit on every
  100th match.

### Events are server-only [engine]

- `match_created` and `match_ended` carry roles, and decisions carry private choices. Clients only ever
  receive `viewFor(state, seat)`.

### API shape [engine]

- `createMatch(config, seed)` has no clock, so it emits no events and returns a match in `lobby`. The
  first `advancePhase(state, now)` logs `match_created` (seq 0) and starts round 1 Invest. This keeps the
  kickoff signature without inventing a timestamp.
- Roles arrive in the config, because matchmaking decides who is an agent. `drawAgentSeats(seed,
weights)` implements SPEC's "0, 1 or 2 agents, equal odds, configurable" for matchmaking and the sim.
- `applyAction` throws `ActionRejectedError` (with a code) and leaves state unchanged. `advancePhase` is a
  no-op before the deadline. `replay(config, seed, inputs)` rebuilds a match from its input log.

### Latency and state hash [engine]

- Decision events carry `phaseStartedAt` and `decidedAt` (server times). The engine does **not** compute
  `latency_ms`: CLAUDE.md invariant 6 says the server measures from prompt sent to choice arrival, which
  the Phase 2 server will record.
- `stateHash` is a 106-bit non-cryptographic hash of the JSON per-seat view the seat had when it decided
  (before the action), or at the deadline for a timeout. It is deterministic and role-independent
  (tested).

### Seeded RNG [engine]

- sfc32 seeded by cyrb128 over the string seed. Its state lives in `MatchState`, so transitions stay pure
  and replays are exact.
- Draw order: reveal mode first, at `createMatch`. Then gamble outcomes at the end of each Gamble phase,
  in seat order, using an unbiased `nextInt(100) < percent`.

### Chat [engine]

- Masking happens inside the engine, before the event is created. Raw contact details never enter the
  log (CLAUDE.md invariant 9).
- Masking is broad: emails (including "(at)" and "(dot)"), URLs, bare domains, invite links, and runs of
  7+ digits. A false mask costs a little fidelity; a miss leaks personal data into training.
- Text is trimmed and limited to 500 characters. Client telemetry (`typingMs`, `pasted`,
  `clientSentAt`) is stored as reported and never trusted.

### Simulator bot policies [engine]

Bots act only through their view and its prompts, the same surface a client or agent gets. Each seat
draws one policy per match.

- **always-cooperate:** invests the max; stakes 10 to a random seat; returns ¾ of what arrived; picks A;
  votes for a visible contributor below 3 (individual mode only); labels everyone human at 60.
- **free-rider:** invests 0, never stakes, returns 0; picks C in risk rounds and A in delay rounds; votes
  randomly half the time; labels randomly.
- **random:** uniform over each prompt's options.
- **tit-for-tat:** invests the others' previous mean; stakes to seats that repaid it before; returns the
  original stake unless burned before; picks B; votes for a visible contributor below 8; labels as
  "agent" anyone who burned it.

All bots let 5% of decisions time out, sometimes defer returns to a later phase, and chat (including
lines that test masking). Reaction times are skewed toward the start of the phase and never instant.

### Simulator observations (not decisions)

Seed `canutell`, 10,000 matches per mode, 0 invariant violations in both.

| policy           | full: pre-Reveal coins | full: final | full: exiled | quick: pre-Reveal | quick: final | quick: exiled |
| ---------------- | ---------------------- | ----------- | ------------ | ----------------- | ------------ | ------------- |
| always-cooperate | 144.8                  | 232.6       | 4.1%         | 124.5             | 212.6        | 2.2%          |
| free-rider       | 219.7                  | 274.4       | 31.3%        | 183.4             | 238.7        | 24.7%         |
| random           | 176.1                  | 242.3       | 12.6%        | 148.5             | 209.6        | 6.4%          |
| tit-for-tat      | 184.1                  | 280.0       | 4.4%         | 144.8             | 234.7        | 1.9%          |

- **Free-riding pays in coins.** With a 1.6× multiplier and n ≥ 3 active players, each coin invested
  returns 1.6/n < 1 to the investor, so Invest is a true social dilemma. That's intended for
  public-goods data, but worth watching for fun.
- **Exile is the counter-pressure.** Free-riders are exiled 31% of the time in full mode, against 4% for
  cooperators. Bots only vote on visible contributions, so all of this comes from individual-mode
  matches.
- **Ballots move the leaderboard.** Reveal adds about 55–90 coins per seat on average, enough that
  tit-for-tat (hedged human labels at 55–74) overtakes free-riders in final score. A player who fills
  every label at 50% banks +100 (see "Ballot payoff at 50/50"). Decide whether that weighting against
  in-round play is intended.
- **Exiles:** 0.79 per full match (56% of matches have none) and 0.53 per quick match (62% have none).
  Exiled seats were agents 16.6% of the time in full mode, matching the 1/6 base rate. That's expected,
  since bots never see roles.
- **Match length:** a median of 134 logged decisions in full mode (range 105–150) and 82 in quick mode
  (range 68–90), including timeouts and returns. Timeouts were 6–7% at the sim's 5% skip rate plus
  deferred returns.

## 2026-10-28 — Phase 2 (real-time loop)

### Phase 2 scope [user]

- **Question.** Four choices for Phase 2: does it include a web client, how are matches persisted before
  Phase 3's database, who plays agent seats before Phase 4, and what happens when fewer than 4 humans are
  available?
- **Decision.** The owner approved all four recommendations:
  1. **Minimal web client.** An unstyled but playable Next.js 15 page, so humans can test the loop.
  2. **JSONL persistence.** Each match is written as append-only JSONL files behind a `MatchStore`
     interface. Postgres replaces them in Phase 3.
  3. **Scripted agents.** Agent seats are played by scripted bots over the public protocol, labelled
     `agent_version = "scripted-0"`, and those matches are flagged.
  4. **Dev-only bot fill.** A server flag (`FILL_BOTS_MS`, off by default) fills empty human seats with
     bots, and those matches are flagged `bot_fill`.
- **Reason.** Real human play is the only way to sanity-check timers. A restart should not lose matches.
  Agent seats should exercise the same protocol path that Phase 4 agents will use.

### Every Phase 2 match is flagged as non-research data [engine, data tradeoff → data]

- `meta.flags` always includes `phase2`. It adds `scripted_agents` when agents are present, `bot_fill`
  when filler bots sat in human seats, and `sped_up` when the server clock ran faster than real time.
- Phase 3 exports must exclude these flags.

### Agent count is drawn before humans gather [engine]

- The public queue draws the next match's agent count (0–2) first, then waits for 6 − k humans.
- `queue.status` carries no player counts. "4 humans waiting, then the match started" would reveal 2
  agents (CLAUDE.md invariant 7).
- Seats are shuffled, so seat numbers say nothing about queue order or roles.

### Parties [engine]

- A party is a private lobby joined by code. It plays with 4–6 humans, and agents fill the remaining
  0–2 seats.
- The party can therefore work out the agent count. That is acceptable only because party matches are
  tagged `is_party` and excluded from detection metrics (SPEC §Integrity, CLAUDE.md invariant 11).
- Parties of fewer than 4 can start only with dev bot fill.

### View pushes [engine, data tradeoff → data]

- A seat gets a new `view` frame only when _its own_ view changed.
- Pushing to everyone on every transition would be a timing side channel: an unchanged view arriving
  right after a private stake between two other seats tells a third seat that something happened.
- The match runner tests this, and the load test checks every frame received.

### Latency (CLAUDE.md invariant 6) [engine]

- `latencyMs = receivedAt − promptSentAt`, both server times.
  - `promptSentAt` is when a view containing that prompt was first written to the seat's socket. If
    the seat was disconnected when the prompt opened, its clock starts when it reconnects.
  - Prompts are identified by `promptKey`: kind + round, or the stake for a return.
- A timed-out decision records whether the seat ever saw the prompt (`promptSentAt` null or not), so
  analysis can tell "saw it and stayed idle" from "never saw it".
- Client `clientSentAt` is stored separately and never trusted.
- Connect and disconnect events are logged per seat.

### Late actions [engine]

- Action frames carry `seenPhase`, the round and phase of the view the client acted on. If the match
  has moved past it when the frame arrives, the rejection is reported as `late`, and the engine's own
  reason (`wrong_phase`, `stake_closed`, …) is kept as `engineCode`.
- Without this, a choice sent just before a deadline and processed just after it is reported as
  "wrong phase", which is misleading for players and noisy in the data.
- Rejections are logged per match: late attempts are behavioral data too.

### Restarts [engine]

- On startup, any stored match still marked `running` is marked `aborted`. Matches are not resumed:
  guest tokens live in memory, so players could not reattach anyway.
- The full input log is stored, so `replay()` can rebuild any interrupted match for analysis.

### Guests and seat tokens [engine]

- Each connection is a guest with a server-issued pseudonymous `playerId` (`p_<uuid>`) and a random
  48-hex-character token. The token lets a reload or reconnect resume the seat. No personal data is
  collected (accounts come in Phase 5).
- Bot seats get a token too, and connect through the same `hello`. Bot tokens cannot join queues or
  parties.

### Frame hygiene [engine]

- Every inbound frame is zod-parsed. Frames are capped at 64 KB.
- Each socket is rate-limited (15 frames/s, burst 30) and closed after 50 invalid frames.
- The engine still validates every action (CLAUDE.md invariant 5).
- An action whose `seat` is not the sender's seat is rejected with `not_your_seat`.

### Scripted bot timing [engine, flagged]

- CLAUDE.md invariant 14 asks agents to sample response times from the human latency distribution.
  There is no human data yet, so scripted bots use a placeholder: a skewed draw over the phase, at
  least 0.8 s, and never past the deadline.
- That gap is one reason scripted-agent matches are flagged. Phase 4 agents must sample from real
  timings.

### Phase 2 acceptance results

- `pnpm loadtest --matches 200 --mode both --speed 60` passed with 0 violations: 400 matches over real
  WebSockets, with 1,200 seated clients per mode. The checks per match:
  - the Phase 1 log audit
  - a byte-identical `replay()` of the server's input log
  - a latency record for every decision
  - no rejection other than `late`
  - no roles in any frame before Reveal, and no frame carrying another seat's view
- Under that stress (×60 clock, 200 concurrent matches), about 0.2% of actions arrived late.
- A browser run (`apps/web/e2e/smoke.mjs`) played a quick match through the real UI at phone width, from
  lobby to Reveal, with no page errors.

---

## 2026-10-28 — Phase 3 (event log, schema, reveal screen)

### Phase 3 plan and migration 0001 [user]

- **Question.** The plan and the proposed migration in `docs/proposals/phase-3.md`, plus four open
  questions.
- **Decision.** The owner approved the plan and migration, with all four recommendations:
  1. **Guest data before accounts:** keep it as flagged dev data and purge it before the closed alpha
     (entry below).
  2. **Schema scope:** match tables plus a minimal `players` table now. `identities`, `consents` and
     `integrity_signals` come with Phase 5.
  3. **Reveal:** live, plus reopenable at `/match/[id]` from the database.
  4. **Database:** standard Postgres, tested locally. There is no Supabase project yet; the server
     connects via `DATABASE_URL` once one exists.

### Guest data before accounts [user, data tradeoff → flagged]

- **The conflict:** SPEC §Integrity says T0 guests are "play only; nothing kept beyond the match", but
  every player is a guest until Phase 5.
- **Decision:** matches are kept, and every one carries its build-phase flag (`phase3`), which means dev
  data that is never research-eligible.
- **Purge:** `pnpm db:purge --flag phase3 --yes` deletes them through the privacy-deletion path. It must
  run before the closed alpha.
- **From Phase 5:** the T0 rule applies as written.

### Differences between migration 0001 and the approved proposal [engine, flagged for review]

Small tightenings made while implementing, all inside the approved migration:

- `stakes.seq`: the seq of the `stake_sent` event. It gives creation order (needed to pick the biggest
  stake and order unreturned stakes exactly as the engine does) and links each row back to the log.
- **Extra constraints:**
  - `seats`: humans have `trust_level_at_match`, and no one else does.
  - `decisions.kind` is restricted to the six decision kinds.
  - `seat_results` must satisfy `final_score = coins + delay + exile + ballot`.
- **`on delete cascade` from `matches`.** It lets the privacy job delete a match in one statement. The
  append-only triggers still fire on every cascaded row, so a cascade without the privacy flag fails
  (tested).
- **`schema_migrations`** is created by the migration runner (with RLS), not by 0001.
- **Extra revokes.** Belt and braces on Supabase: `revoke all … from anon, authenticated` on tables,
  sequences and functions when those roles exist, plus `revoke all … from public`.

### Phase 3 write path [engine]

- **One transaction per transition.** Everything one engine transition produces (input, events,
  timings) is buffered in the same tick and committed in one transaction, through an ordered per-match
  queue. The database therefore always holds the log up to the last completed transition, never half of
  one.
- **Retries:** failed batches retry with backoff, without reordering.
- **Permanent failure:** if a batch still fails, it is reported and every later batch for that match is
  held back. Writing them would leave a gap in the append-only log. The match stays `running` and is
  marked `aborted` at the next startup.
- **"Completed" guarantees derived rows.** On match end, derivation and the `completed` status commit
  in one transaction, so a reveal is reopenable the moment the match says it is finished. If derivation
  fails, the status is still written, the error is reported, and `pnpm db:derive` can rebuild later.
- **Startup:** the server refuses to start while migrations are pending (they are applied deliberately
  with `pnpm db:migrate`), then marks any `running` match `aborted`.

### Derived tables [engine]

- **Pure derivation.** `deriveRows(events, timings)` is a pure function. It is strict: a sequence gap, a
  missing timing record, or a timing that disagrees with its event throws instead of producing a
  plausible row.
- **Prompt delivery:** `decisions.prompt_seen` records whether the prompt ever reached the seat.
- **Ballots:** one row per (voter, target), with blanks explicit.
- **Self-check:** the reveal rebuilt from derived tables must equal the engine's own reveal, for every
  match in tests and in the Postgres load test.
- **Comparing logs:** Postgres `jsonb` does not keep key order, so logs read back are compared to
  in-memory logs in canonical (key-sorted) JSON. Values are unchanged.

### Reopening a reveal [engine]

- **Endpoint:** `GET /api/matches/:id/reveal` with `Authorization: Bearer <guest token>`. It answers
  only a player who held a human seat in that match. Everyone else gets 404, which gives no hint the
  match exists; a missing token gets 401.
- **Response:** the reveal is built from derived tables, plus that player's own stakes.
- **Guest limitation:** guest tokens live in server memory, so a reveal can be reopened only from the
  device that played it, and only until the server restarts. Phase 5 accounts lift this.
- **Leaderboard:** AI players are listed separately (SPEC §Scoring: agents never appear on human
  leaderboards). Phase 2's single mixed table broke that.

### Test databases [engine]

- **Default:** tests run against PGlite (in-process Postgres 18) with no setup.
- **Real Postgres:** `TEST_DATABASE_URL=postgres://…` runs the same tests against real Postgres, each
  test file in a throwaway database. Both pass (local Postgres 16).

### Phase 3 acceptance results

- **Load test:** `pnpm loadtest --matches 200 --mode both --store postgres` (local Postgres 16) passed
  with 0 violations over 400 matches. Per match:
  - the database log equals the server log (events, inputs, timings, connections, rejections)
  - the database-built reveal equals the engine reveal
  - derived rows reconcile
- **HTTP reveals:** 80 checked and correct; every unauthorized request refused.
- **Browser smoke test** (3 runs, Postgres-backed server): played to Reveal, followed the permanent link,
  and the reopened page matched the live reveal exactly; a browser without the player's token was
  refused.
- **Suite:** 221 tests pass, including 31 database tests on both PGlite and Postgres 16.

---

## Later

Noted while building Phase 1; out of scope for this phase.

- **Choice revisions before the deadline.** Hesitation and "changed mind" data. Needs a rule decision
  (see "One submission per decision").
- **Ruleset versioning in the engine,** so matches logged under an old `ruleset_version` stay replayable
  after rule changes.
- **Parallel simulator** (worker threads). About 100 matches/s single-threaded, dominated by computing a
  view and hash per decision for `state_hash`.
- **Stronger chat masking:** spelled-out numbers, handles ("@name on insta"), non-Latin digits. Measure
  against a hand-labelled set, as SPEC does for promise detection.
- **Menu pools** for Gamble (SPEC: "menu pools come later").
- **The cold-start fill question** in SPEC §Open questions affects `drawAgentSeats` weights and the H
  calculation.
- **Resume matches after a restart.** Persist guest sessions (or wait for Phase 5 accounts), replay
  running matches from their input logs, and let players reattach.
- **A human latency model for agents** (CLAUDE.md invariant 14), once Phase 3 has real timing data.
- **Horizontal scaling.** One process holds all matches today. Sharding by match id with sticky
  WebSocket routing comes later.
- **Real UI design** (cosmetics hooks, accessibility pass). Phase 2's client is deliberately minimal.
- **Production build of the server.** Today it runs from TypeScript source via `tsx`. Bundle it for
  deployment on a persistent-process host (not serverless).
- **Supabase project hookup.** Create the project, `pnpm db:migrate` against it, and set the server's
  `DATABASE_URL` (service role / direct connection).
- **CI against real Postgres** (`TEST_DATABASE_URL`) in addition to PGlite.
- **Reopening a reveal after a server restart.** Needs persistent identities (Phase 5).
- **Training-export views.** Encode CLAUDE.md invariant 10 (`is_agent = false`, trust >= T2, active
  consent) as a database view in Phase 5, together with `consents`.
