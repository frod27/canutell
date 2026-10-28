import { z } from 'zod';
import {
  BallotLabelSchema,
  BallotLabelValueSchema,
  ChatChannelSchema,
  CoinsSchema,
  ConfidenceSchema,
  GambleMenuKindSchema,
  GambleOptionSchema,
  ModeSchema,
  NonNegCoinsSchema,
  PhaseSchema,
  RevealModeSchema,
  SeatIdSchema,
  ServerTimeSchema,
  TimedPhaseSchema,
} from './common';

// Per-seat view (CLAUDE.md invariants 4 and 7). Everything here is safe to send to that seat's client.
// Before Reveal: no roles, no agent count, no other seat's contribution (aggregate mode), stake, gamble,
// vote or ballot. `reveal` is null until the match reaches the `reveal` phase.

const RoundSchema = z.number().int().min(1);

const GambleOptionSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sure'), amount: z.number().int() }),
  z.object({ kind: z.literal('chance'), amount: z.number().int(), percent: z.number().int() }),
  z.object({ kind: z.literal('now'), amount: z.number().int() }),
  z.object({ kind: z.literal('at_end'), amount: z.number().int() }),
  z.object({ kind: z.literal('at_end_if_not_exiled'), amount: z.number().int() }),
]);

/** A decision this seat may make right now, with its exact option set. */
export const PromptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invest'), min: z.literal(0), max: NonNegCoinsSchema }),
  /** A stake of min..max to one target, or a deliberate pass ({to: null, amount: 0}). */
  z.object({
    kind: z.literal('stake'),
    targets: z.array(SeatIdSchema),
    min: z.number().int(),
    max: NonNegCoinsSchema,
  }),
  z.object({
    kind: z.literal('return'),
    stakeId: z.string(),
    from: SeatIdSchema,
    received: NonNegCoinsSchema,
    min: z.literal(0),
    max: NonNegCoinsSchema,
    deadlineRound: RoundSchema,
  }),
  z.object({
    kind: z.literal('gamble'),
    menu: GambleMenuKindSchema,
    options: z.object({ A: GambleOptionSpecSchema, B: GambleOptionSpecSchema, C: GambleOptionSpecSchema }),
  }),
  /** Vote for one target, or skip ({target: null}). */
  z.object({ kind: z.literal('vote'), targets: z.array(SeatIdSchema) }),
  z.object({ kind: z.literal('ballot'), targets: z.array(SeatIdSchema) }),
]);
export type Prompt = z.infer<typeof PromptSchema>;

/**
 * No global message index: it would reveal how many DMs and exile messages this seat cannot see.
 */
export const ChatMessageViewSchema = z.object({
  round: RoundSchema,
  phase: TimedPhaseSchema,
  from: SeatIdSchema,
  channel: ChatChannelSchema,
  to: SeatIdSchema.nullable(),
  text: z.string(),
  at: ServerTimeSchema,
});
export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

const RevealSeatSchema = z.object({
  seatId: SeatIdSchema,
  isAgent: z.boolean(),
  agentVersion: z.string().nullable(),
  exiledRound: RoundSchema.nullable(),
  coinsBeforeReveal: CoinsSchema,
  delayPaid: NonNegCoinsSchema,
  exileBonus: CoinsSchema,
  ballotPayoff: CoinsSchema,
  finalScore: CoinsSchema,
  ballotAccuracy: z.object({ labeled: z.number().int(), correct: z.number().int() }),
});

const RevealStakeSchema = z.object({
  stakeId: z.string(),
  round: RoundSchema,
  from: SeatIdSchema,
  to: SeatIdSchema,
  sent: NonNegCoinsSchema,
  returned: NonNegCoinsSchema,
});

export const RevealViewSchema = z.object({
  seats: z.array(RevealSeatSchema),
  ballots: z.array(
    z.object({
      voter: SeatIdSchema,
      timedOut: z.boolean(),
      labels: z.array(
        z.object({
          target: SeatIdSchema,
          label: BallotLabelValueSchema,
          confidence: ConfidenceSchema,
          payoff: CoinsSchema,
          applied: z.boolean(),
        }),
      ),
    }),
  ),
  votes: z.array(
    z.object({
      round: RoundSchema,
      exiled: SeatIdSchema.nullable(),
      tally: z.array(z.number().int()),
      ballots: z.array(
        z.object({ voter: SeatIdSchema, target: SeatIdSchema.nullable(), timedOut: z.boolean() }),
      ),
    }),
  ),
  keyMoments: z.object({
    biggestStake: RevealStakeSchema.nullable(),
    unreturnedStakes: z.array(RevealStakeSchema),
    exiles: z.array(z.object({ round: RoundSchema, seat: SeatIdSchema, isAgent: z.boolean() })),
  }),
});
export type RevealView = z.infer<typeof RevealViewSchema>;

export const SeatViewSchema = z.object({
  matchId: z.string(),
  rulesetVersion: z.string(),
  mode: ModeSchema,
  revealMode: RevealModeSchema,
  totalRounds: z.number().int(),
  seat: SeatIdSchema,
  round: z.number().int().nonnegative(),
  phase: PhaseSchema,
  phaseStartedAt: ServerTimeSchema.nullable(),
  deadline: ServerTimeSchema.nullable(),

  self: z.object({ balance: CoinsSchema, exiledRound: RoundSchema.nullable() }),
  /** Public seat status. Exile is public; the exiled seat's role is not (SPEC §Vote). */
  seats: z.array(z.object({ seatId: SeatIdSchema, exiledRound: RoundSchema.nullable() })),

  prompts: z.array(PromptSchema),
  chat: z.object({
    channels: z.array(ChatChannelSchema),
    dmTargets: z.array(SeatIdSchema),
    messages: z.array(ChatMessageViewSchema),
  }),

  investResults: z.array(
    z.object({
      round: RoundSchema,
      pot: NonNegCoinsSchema,
      share: NonNegCoinsSchema,
      activeCount: z.number().int(),
      /** Present only in `individual` reveal mode. */
      contributions: z.array(z.object({ seat: SeatIdSchema, amount: NonNegCoinsSchema })).nullable(),
    }),
  ),
  myContributions: z.array(z.object({ round: RoundSchema, amount: NonNegCoinsSchema })),
  stakesSent: z.array(
    z.object({
      stakeId: z.string(),
      round: RoundSchema,
      to: SeatIdSchema,
      sent: NonNegCoinsSchema,
      received: NonNegCoinsSchema,
      returned: NonNegCoinsSchema.nullable(),
      returnDeadlineRound: RoundSchema,
    }),
  ),
  stakesReceived: z.array(
    z.object({
      stakeId: z.string(),
      round: RoundSchema,
      from: SeatIdSchema,
      sent: NonNegCoinsSchema,
      received: NonNegCoinsSchema,
      returned: NonNegCoinsSchema.nullable(),
      returnDeadlineRound: RoundSchema,
    }),
  ),
  myGambles: z.array(
    z.object({
      round: RoundSchema,
      menu: GambleMenuKindSchema,
      option: GambleOptionSchema,
      /** null until the Gamble phase resolves. */
      immediate: NonNegCoinsSchema.nullable(),
    }),
  ),
  myDelays: z.array(
    z.object({
      round: RoundSchema,
      option: GambleOptionSchema,
      amount: NonNegCoinsSchema,
      onlyIfNotExiled: z.boolean(),
      status: z.enum(['pending', 'paid', 'forfeited']),
    }),
  ),
  myVotes: z.array(z.object({ round: RoundSchema, target: SeatIdSchema.nullable() })),
  /** Outcome only. Tallies and who voted for whom stay hidden until Reveal (DECISIONS "Vote visibility"). */
  voteResults: z.array(z.object({ round: RoundSchema, exiled: SeatIdSchema.nullable() })),
  myBallot: z.object({ labels: z.array(BallotLabelSchema) }).nullable(),

  reveal: RevealViewSchema.nullable(),
});
export type SeatView = z.infer<typeof SeatViewSchema>;
