# CANUTELL — Spec v0.2

Source of truth for rules and data. Section names are cited by tests (e.g. `// SPEC §Invest`).

## Purpose

Gather clean, consented behavioral data, and use it to train agents that get progressively harder to tell from humans. Fun is how the game earns players.

## Match structure

- 6 seats. Each match seats 0, 1 or 2 agents (MVP: equal odds, configurable). The lobby states that the match may contain AI players.
- Modes:
  - **Full:** 5 rounds, about 11.5 minutes.
  - **Quick:** 3 rounds, about 7 minutes.
- Each round has four phases, in order: Invest, Deal, Gamble, Vote. Round 1 has no Vote.
- After the last round: Final ballot, then Reveal.
- **Reveal mode** is drawn per match from the seeded RNG, 50/50:
  - `individual`: everyone sees each player's contribution after Invest.
  - `aggregate`: only the pot total is shown.

| Phase | Duration |
| --- | --- |
| Invest | 30 s |
| Deal | 60 s |
| Gamble | 15 s |
| Vote | 30 s |
| Final ballot | 45 s |

**Timeouts.** A seat that doesn't act before a deadline gets the default effect: contribute 0, no stake, option A, skip vote, ballot left blank. The decision is logged with `timed_out = true`, never as a real choice. Analysis must be able to tell a deliberate 0 from a timeout.

## Coins

Every player starts with 100 coins. Coins are integers, game-only, and never purchasable or cashable.

### Coin math

All coins created or destroyed must be explained by a named event, and conservation is checked after every transition.

- **Pot payout:** pot P, active players n. Each active player receives `floor(P * 16 / (10 * n))`. The remainder, `P - n * payout_share_of_P`, is destroyed and logged as `pot_remainder_burned`. The 0.6 × P growth is logged as `pot_multiplied`.
- **Stake doubling:** sending s coins creates s new coins on arrival, logged as `stake_multiplied`.
- **Gamble wins** are created coins (`gamble_won`). Delayed payouts are created at match end (`delay_paid`).
- **Ballot payoffs and exile bonuses** are created or destroyed at Reveal (`ballot_scored`, `exile_bonus`).

## Phases

### Invest
Each active player privately chooses 0–20 coins, capped at their balance. Then the pot is multiplied and split per §Coin math. The visible result depends on reveal mode.

### Deal
- Public table chat and private 1:1 messages run throughout.
- **Stake:** each active player may send at most one stake per round: 1–20 coins to one other active player. The amount doubles on arrival.
- **Return:** the receiver may return 0 to 2s coins to the sender, once per stake. The return can happen any time before the end of the *next* Deal phase, or the end of the last round's Deal if there is no next one. No action means a return of 0, logged with `timed_out = true`.
- Promises in chat are not enforced.

### Gamble
One private choice per active player.

| Rounds (full mode) | Rounds (quick mode) | A | B | C |
| --- | --- | --- | --- | --- |
| 1, 3, 5 (risk) | 1, 3 (risk) | +5 for sure | 50%: +12, else 0 | 20%: +30, else 0 |
| 2, 4 (delay) | 2 (delay) | +5 now | +8 at match end | +12 at match end, only if not exiled |

MVP uses these fixed menus; menu pools come later. Outcomes are drawn from the seeded RNG.

### Vote
- Runs in rounds 2 onward. Each active player, human or agent, votes for one other active player or skips.
- A player is exiled if they receive 3 or more votes **and** strictly more than anyone else. Otherwise no one is exiled.
- **An exiled player:**
  - keeps their coins;
  - takes no further Invest, Deal, Gamble or Vote actions;
  - forfeits their pending "+12 if not exiled" payouts but keeps "+8 at match end";
  - can chat only in the exile channel;
  - can still return stakes they received before exile.
- **The exiled player's role is not revealed until Reveal.** This is deliberate: an early reveal would contaminate later votes and ballots.

### Final ballot
Every player, exiled or not, privately labels each other seat as `agent` or `human`, with an integer confidence from 50 to 100. Agents also fill ballots; their ballots are logged but never scored for humans.

## Scoring (humans)

Final score = coins + exile bonuses + ballot payoff.

- **Exile bonus:** +10 for each human who voted to exile a seat that turned out to be an agent, and −5 for voting to exile a human. Applied at Reveal.
- **Ballot payoff**, per label:
  - q = confidence/100 for an `agent` label, or 1 − confidence/100 for a `human` label.
  - y = 1 if the target is an agent, else 0.
  - B = 40 × (0.75 − (q − y)²), rounded to the nearest integer, half away from zero.
  - Range: +30 for a certain correct label, −10 for a certain wrong one, +20 at 50/50 (either label, either role). Before rounding the rule is strictly proper, so honest confidence maximizes expected payoff; after rounding, the honest report is within 1 coin per label of the best expected payoff.
  - A blank label scores 0.
- Agents are ranked separately and never appear on human leaderboards.

## Reveal

Shows every seat's role and agent version, each player's ballot accuracy, final scores, and key moments (biggest stake, unreturned stakes, exiles).

## Agents

| Class | Decisions | Chat |
| --- | --- | --- |
| Baseline | A fast decision model picks from the phase's option set, with a confidence | LLM with a persona and style guide |
| Mimic | Model trained on verified-human decision logs | LLM tuned on verified-human chat |

Rules for all agents:
- Response timing is sampled from the human latency distribution for that phase.
- Agents never claim to be a real person, never ask for personal information, and never invite anyone off-platform.
- Agents connect through the same protocol as humans.
- Agents are always revealed at match end.

**Humanlikeness** per agent version: H = P(labeled human | agent) / P(labeled human | human), computed from non-party matches. H = 1 means indistinguishable.

## Training loop

1. **Collect:** the pool is seats with `is_agent = false`, `trust_level >= T2`, and active research consent.
2. **Train** the next Mimic on decisions given the player's view, plus chat and timing.
3. **Test offline** on 20% of matches held out by match_id. The new version must beat the current one at predicting held-out decisions.
4. **Duel live:** new and current versions split agent seats.
5. **Ship** only if the new version's H beats the current one across at least 300 matches each.

**First Mimic gate:** 2,000 verified-human matches **and** 500 distinct verified players.

Agents trained here are never deployed outside CANUTELL.

## Integrity

| Level | Requirement | Data use |
| --- | --- | --- |
| T3 | T2 plus 10+ matches with no automation flags | Training, evaluation, research |
| T2 | Account, passkey or phone verification, confirmed 18+ | Training, evaluation |
| T1 | Signed-in account | Play only |
| T0 | Guest | Play only; nothing kept beyond the match |

- **Automation signals,** logged per seat: input timing variance, paste events in chat, tab focus and blur, headless-browser fingerprints, and replies faster than reading time. Flags lower trust; they never auto-ban without review.
- **Party queues** are allowed and tagged with `is_party`.

## Data schema

Append-only `events` table: `event_id, match_id, seq, type, seat_id, payload jsonb, server_ts`. All tables below are derived from or written alongside it.

| Table | Key fields |
| --- | --- |
| players | player_id, created_at, trust_level, research_opt_in |
| identities (locked) | player_id, email_hash, verification_method, age_confirmed |
| matches | match_id, started_at, mode, ruleset_version, reveal_mode, agent_count, is_party, seed |
| seats | match_id, seat_id, player_id or agent_version, is_agent, trust_level_at_match |
| decisions | decision_id, match_id, round, seat_id, phase, option_set, chosen, confidence, latency_ms, timed_out, state_hash |
| stakes | stake_id, match_id, round, from_seat, to_seat, sent, received, returned, return_timed_out |
| messages | message_id, match_id, round, from_seat, channel (table, dm, exile), to_seat, text, sent_at, typing_ms, pasted |
| ballots | match_id, voter_seat, target_seat, label, confidence, payoff |
| integrity_signals | match_id, seat_id, signal, value, flagged |
| agent_versions | agent_version, class, decision_model, chat_model, trained_on, released_at |
| consents | player_id, consent_type, version, granted_at, revoked_at |

`state_hash` identifies the exact per-seat view the player saw when deciding, so any decision can be replayed.

## Behavioral measures (derived)

- **Cooperation:** contribution ÷ 20.
- **Conditional cooperation:** slope of contribution on the others' previous-round mean.
- **Reputation effect:** cooperation in individual vs aggregate reveal mode.
- **Trust:** stake sent.
- **Trustworthiness:** returned ÷ received.
- **Promise-keeping:** chat promises vs later actions, using a classifier validated on a hand-labeled set.
- **Risk attitude:** from risk-menu choices.
- **Patience:** from delay-menu choices.
- **Detection skill:** Brier score on ballots.
- **Deliberation:** latency.

## Consent and privacy

- Only players confirmed 18+ have data kept for training.
- Research use is a separate opt-in. Revoking it removes the player from future training exports.
- Chat masks phone numbers, emails and links. Personal details are stripped before training.
- Raw chat retention window: **open**.

## Monetization

Cosmetics and a season pass only. Nothing that changes payoffs, information or odds.

## Open questions

- Raw chat retention window.
- USPTO trademark search on CANUTELL.
- Share of quick vs full matches in default matchmaking.
- **Cold-start fill:** the 0–2 agent cap requires 4 humans per match. Should thin queues allow more agents? If so, the lobby disclosure and the H calculation must account for the different base rate.
