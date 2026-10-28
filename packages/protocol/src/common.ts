import { z } from 'zod';
import { CONFIDENCE_MAX, CONFIDENCE_MIN, SEAT_COUNT } from './rules';

export const SeatIdSchema = z
  .number()
  .int()
  .min(0)
  .max(SEAT_COUNT - 1);
export type SeatId = z.infer<typeof SeatIdSchema>;

export const ModeSchema = z.enum(['full', 'quick']);
export type Mode = z.infer<typeof ModeSchema>;

export const RevealModeSchema = z.enum(['individual', 'aggregate']);
export type RevealMode = z.infer<typeof RevealModeSchema>;

/** `lobby` precedes the first advancePhase; `reveal` is terminal. */
export const PhaseSchema = z.enum(['lobby', 'invest', 'deal', 'gamble', 'vote', 'final_ballot', 'reveal']);
export type Phase = z.infer<typeof PhaseSchema>;

export const TimedPhaseSchema = z.enum(['invest', 'deal', 'gamble', 'vote', 'final_ballot']);
export type TimedPhase = z.infer<typeof TimedPhaseSchema>;

export const GambleMenuKindSchema = z.enum(['risk', 'delay']);
export const GambleOptionSchema = z.enum(['A', 'B', 'C']);

export const BallotLabelValueSchema = z.enum(['agent', 'human']);
export type BallotLabelValue = z.infer<typeof BallotLabelValueSchema>;

export const ConfidenceSchema = z.number().int().min(CONFIDENCE_MIN).max(CONFIDENCE_MAX);

export const BallotLabelSchema = z.object({
  target: SeatIdSchema,
  label: BallotLabelValueSchema,
  confidence: ConfidenceSchema,
});
export type BallotLabel = z.infer<typeof BallotLabelSchema>;

export const ChatChannelSchema = z.enum(['table', 'dm', 'exile']);
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

/** Integer coin amount. Balances may only go negative at Reveal (DECISIONS "Negative final scores"). */
export const CoinsSchema = z.number().int();
export const NonNegCoinsSchema = z.number().int().nonnegative();

/** Server time in ms since epoch (or any monotonic origin). Never a client clock. */
export const ServerTimeSchema = z.number().int().nonnegative();
