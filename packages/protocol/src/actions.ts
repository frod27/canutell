import { z } from 'zod';
import { BallotLabelSchema, ChatChannelSchema, GambleOptionSchema, SeatIdSchema } from './common';
import { CHAT_MAX_LENGTH, INVEST_MAX, SEAT_COUNT, STAKE_MAX, STAKE_MULTIPLIER } from './rules';

// Clients send choices only (CLAUDE.md invariant 5). These schemas check shape and static bounds;
// the engine checks everything that depends on state (phase, balance, exile, deadlines).

/** SPEC §Invest */
export const InvestActionSchema = z.object({
  type: z.literal('invest'),
  seat: SeatIdSchema,
  amount: z.number().int().min(0).max(INVEST_MAX),
});

/**
 * SPEC §Deal. `to: null, amount: 0` is a deliberate "no stake", so it can be told apart from a timeout
 * (DECISIONS "Deliberate pass on stake").
 */
export const StakeActionSchema = z
  .object({
    type: z.literal('stake'),
    seat: SeatIdSchema,
    to: SeatIdSchema.nullable(),
    amount: z.number().int().min(0).max(STAKE_MAX),
  })
  .refine((a) => (a.to === null) === (a.amount === 0), {
    message: 'a pass is {to: null, amount: 0}; a stake needs a target and amount ≥ 1',
  });

/** SPEC §Deal: the receiver returns 0..2s, once per stake. */
export const ReturnActionSchema = z.object({
  type: z.literal('return'),
  seat: SeatIdSchema,
  stakeId: z.string().min(1).max(32),
  amount: z
    .number()
    .int()
    .min(0)
    .max(STAKE_MAX * STAKE_MULTIPLIER),
});

/** SPEC §Gamble */
export const GambleActionSchema = z.object({
  type: z.literal('gamble'),
  seat: SeatIdSchema,
  option: GambleOptionSchema,
});

/** SPEC §Vote. `target: null` is a deliberate skip. */
export const VoteActionSchema = z.object({
  type: z.literal('vote'),
  seat: SeatIdSchema,
  target: SeatIdSchema.nullable(),
});

/** SPEC §Final ballot. Targets left out are deliberately blank. */
export const BallotActionSchema = z.object({
  type: z.literal('ballot'),
  seat: SeatIdSchema,
  labels: z.array(BallotLabelSchema).max(SEAT_COUNT - 1),
});

/** Client-reported telemetry. Stored as-is and never trusted (CLAUDE.md invariant 6). */
export const ClientTelemetrySchema = z.object({
  typingMs: z.number().int().nonnegative().max(3_600_000).nullable(),
  pasted: z.boolean().nullable(),
  clientSentAt: z.number().nullable(),
});
export type ClientTelemetry = z.infer<typeof ClientTelemetrySchema>;

/** SPEC §Deal (chat), §Vote (exile channel). */
export const ChatActionSchema = z.object({
  type: z.literal('chat'),
  seat: SeatIdSchema,
  channel: ChatChannelSchema,
  to: SeatIdSchema.nullable(),
  text: z.string().min(1).max(CHAT_MAX_LENGTH),
  client: ClientTelemetrySchema.nullable(),
});

export const ActionSchema = z.discriminatedUnion('type', [
  InvestActionSchema,
  StakeActionSchema,
  ReturnActionSchema,
  GambleActionSchema,
  VoteActionSchema,
  BallotActionSchema,
  ChatActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export type InvestAction = z.infer<typeof InvestActionSchema>;
export type StakeAction = z.infer<typeof StakeActionSchema>;
export type ReturnAction = z.infer<typeof ReturnActionSchema>;
export type GambleAction = z.infer<typeof GambleActionSchema>;
export type VoteAction = z.infer<typeof VoteActionSchema>;
export type BallotAction = z.infer<typeof BallotActionSchema>;
export type ChatAction = z.infer<typeof ChatActionSchema>;
export type ActionType = Action['type'];
