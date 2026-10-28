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
  RevealModeSchema,
  SeatIdSchema,
  ServerTimeSchema,
  TimedPhaseSchema,
} from './common';
import { ClientTelemetrySchema } from './actions';
import { SeatConfigSchema } from './config';

// The append-only event log (CLAUDE.md invariant 8, SPEC §Data schema `events`).
// Events are SERVER-SIDE ONLY. Some carry roles (match_created, match_ended) or private choices;
// clients receive per-seat views, never raw events.

const RoundSchema = z.number().int().min(1);

// ---------- decisions (SPEC §Data schema `decisions`) ----------

const DecisionBase = {
  round: RoundSchema,
  phase: TimedPhaseSchema,
  /** SPEC §Match structure "Timeouts": a default effect, never logged as a real choice. */
  timedOut: z.boolean(),
  /** Hash of the per-seat view the seat saw when deciding (SPEC §Data schema `state_hash`). */
  stateHash: z.string().regex(/^[0-9a-f]{28}$/),
  phaseStartedAt: ServerTimeSchema,
  /** Server time the choice was applied, or the deadline for a timeout. */
  decidedAt: ServerTimeSchema,
};

export const DecisionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    ...DecisionBase,
    kind: z.literal('invest'),
    optionSet: z.object({ min: z.literal(0), max: NonNegCoinsSchema }),
    chosen: z.object({ amount: NonNegCoinsSchema }),
  }),
  z.object({
    ...DecisionBase,
    kind: z.literal('stake'),
    optionSet: z.object({ targets: z.array(SeatIdSchema), min: z.number().int(), max: NonNegCoinsSchema }),
    chosen: z.object({ to: SeatIdSchema.nullable(), amount: NonNegCoinsSchema }),
  }),
  z.object({
    ...DecisionBase,
    kind: z.literal('return'),
    optionSet: z.object({ stakeId: z.string(), min: z.literal(0), max: NonNegCoinsSchema }),
    chosen: z.object({ amount: NonNegCoinsSchema }),
  }),
  z.object({
    ...DecisionBase,
    kind: z.literal('gamble'),
    optionSet: z.object({ menu: GambleMenuKindSchema }),
    chosen: z.object({ option: GambleOptionSchema }),
  }),
  z.object({
    ...DecisionBase,
    kind: z.literal('vote'),
    optionSet: z.object({ targets: z.array(SeatIdSchema) }),
    chosen: z.object({ target: SeatIdSchema.nullable() }),
  }),
  z.object({
    ...DecisionBase,
    kind: z.literal('ballot'),
    optionSet: z.object({ targets: z.array(SeatIdSchema) }),
    chosen: z.object({ labels: z.array(BallotLabelSchema) }),
  }),
]);
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;
export type DecisionKind = DecisionPayload['kind'];

// ---------- event payloads ----------

export const EventPayloadSchemas = {
  match_created: z.object({
    rulesetVersion: z.string(),
    mode: ModeSchema,
    isParty: z.boolean(),
    revealMode: RevealModeSchema,
    totalRounds: z.number().int(),
    seed: z.string(),
    seats: z.array(SeatConfigSchema),
  }),
  phase_started: z.object({
    round: RoundSchema,
    phase: TimedPhaseSchema,
    startedAt: ServerTimeSchema,
    deadline: ServerTimeSchema,
  }),
  phase_ended: z.object({ round: RoundSchema, phase: TimedPhaseSchema }),
  decision: DecisionPayloadSchema,

  // Invest (coins move balance -> pot -> balances)
  contribution_made: z.object({ round: RoundSchema, amount: NonNegCoinsSchema }),
  /** Coins created: floor(16P/10) - P. */
  pot_multiplied: z.object({ round: RoundSchema, pot: NonNegCoinsSchema, created: NonNegCoinsSchema }),
  /** Coins destroyed: floor(16P/10) - n * share. */
  pot_remainder_burned: z.object({ round: RoundSchema, destroyed: NonNegCoinsSchema }),
  pot_paid: z.object({
    round: RoundSchema,
    activeCount: z.number().int().min(1),
    share: NonNegCoinsSchema,
    recipients: z.array(SeatIdSchema),
  }),
  invest_revealed: z.object({
    round: RoundSchema,
    revealMode: RevealModeSchema,
    pot: NonNegCoinsSchema,
    share: NonNegCoinsSchema,
    contributions: z.array(z.object({ seat: SeatIdSchema, amount: NonNegCoinsSchema })).nullable(),
  }),

  // Deal
  stake_sent: z.object({
    stakeId: z.string(),
    round: RoundSchema,
    from: SeatIdSchema,
    to: SeatIdSchema,
    amount: NonNegCoinsSchema,
    returnDeadlineRound: RoundSchema,
  }),
  /** Coins created on arrival: s. */
  stake_multiplied: z.object({ stakeId: z.string(), created: NonNegCoinsSchema }),
  stake_returned: z.object({
    stakeId: z.string(),
    from: SeatIdSchema,
    to: SeatIdSchema,
    amount: NonNegCoinsSchema,
    timedOut: z.boolean(),
  }),
  chat_message: z.object({
    round: RoundSchema,
    phase: TimedPhaseSchema,
    channel: ChatChannelSchema,
    to: SeatIdSchema.nullable(),
    /** Masked text (SPEC §Consent and privacy). The raw text is never logged. */
    text: z.string(),
    masked: z.boolean(),
    client: ClientTelemetrySchema.nullable(),
  }),

  // Gamble
  /** Coins created: immediate gamble payouts (risk A/B/C wins, delay A). */
  gamble_won: z.object({
    round: RoundSchema,
    menu: GambleMenuKindSchema,
    option: GambleOptionSchema,
    created: NonNegCoinsSchema,
  }),
  gamble_lost: z.object({ round: RoundSchema, menu: GambleMenuKindSchema, option: GambleOptionSchema }),
  delay_scheduled: z.object({
    round: RoundSchema,
    option: GambleOptionSchema,
    amount: NonNegCoinsSchema,
    onlyIfNotExiled: z.boolean(),
  }),
  delay_forfeited: z.object({ round: RoundSchema, amount: NonNegCoinsSchema, exiledRound: RoundSchema }),

  // Vote
  vote_resolved: z.object({
    round: RoundSchema,
    tally: z.array(z.number().int().nonnegative()),
    exiled: SeatIdSchema.nullable(),
  }),
  seat_exiled: z.object({ round: RoundSchema, votes: z.number().int() }),

  // Reveal
  /** Coins created at match end. */
  delay_paid: z.object({ round: RoundSchema, created: NonNegCoinsSchema }),
  /** Coins created (+10) or destroyed (-5). seat = the human voter. */
  exile_bonus: z.object({
    round: RoundSchema,
    target: SeatIdSchema,
    targetIsAgent: z.boolean(),
    delta: CoinsSchema,
  }),
  /**
   * One per non-blank label. `payoff` is always computed; it moves coins only when `applied`
   * (human voters). Agent ballots are logged but never scored (SPEC §Final ballot).
   */
  ballot_scored: z.object({
    target: SeatIdSchema,
    label: BallotLabelValueSchema,
    confidence: ConfidenceSchema,
    targetIsAgent: z.boolean(),
    payoff: CoinsSchema,
    applied: z.boolean(),
  }),
  match_ended: z.object({
    finalScores: z.array(CoinsSchema),
    seats: z.array(SeatConfigSchema),
  }),
} as const;

export type EventType = keyof typeof EventPayloadSchemas;
export const EVENT_TYPES = Object.keys(EventPayloadSchemas) as EventType[];

const envelope = <T extends EventType>(type: T) =>
  z.object({
    matchId: z.string(),
    /** Match sequence number, contiguous from 0. */
    seq: z.number().int().nonnegative(),
    type: z.literal(type),
    /** Seat the event belongs to, or null for match-level events. */
    seat: SeatIdSchema.nullable(),
    serverTs: ServerTimeSchema,
    payload: EventPayloadSchemas[type],
  });

export const EventSchema = z.discriminatedUnion('type', [
  envelope('match_created'),
  envelope('phase_started'),
  envelope('phase_ended'),
  envelope('decision'),
  envelope('contribution_made'),
  envelope('pot_multiplied'),
  envelope('pot_remainder_burned'),
  envelope('pot_paid'),
  envelope('invest_revealed'),
  envelope('stake_sent'),
  envelope('stake_multiplied'),
  envelope('stake_returned'),
  envelope('chat_message'),
  envelope('gamble_won'),
  envelope('gamble_lost'),
  envelope('delay_scheduled'),
  envelope('delay_forfeited'),
  envelope('vote_resolved'),
  envelope('seat_exiled'),
  envelope('delay_paid'),
  envelope('exile_bonus'),
  envelope('ballot_scored'),
  envelope('match_ended'),
]);
export type MatchEvent = z.infer<typeof EventSchema>;
export type EventOf<T extends EventType> = Extract<MatchEvent, { type: T }>;
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloadSchemas)[T]>;

/** The prompt key (see views.ts `promptKey`) a decision answers. */
export function decisionPromptKey(d: DecisionPayload): string {
  return d.kind === 'return' ? `return:${d.optionSet.stakeId}` : `${d.kind}:${d.round}`;
}
