import { z } from 'zod';
import { ModeSchema, SeatIdSchema } from './common';
import { MAX_AGENTS, SEAT_COUNT } from './rules';

/**
 * One seat's role. Roles are server-only: they appear in the config and the event log,
 * never in a per-seat view before Reveal (CLAUDE.md invariant 7).
 */
export const SeatConfigSchema = z
  .object({
    seatId: SeatIdSchema,
    isAgent: z.boolean(),
    agentVersion: z.string().min(1).max(64).nullable(),
  })
  .refine((s) => s.isAgent === (s.agentVersion !== null), {
    message: 'agentVersion must be set exactly when isAgent is true',
  });
export type SeatConfig = z.infer<typeof SeatConfigSchema>;

/** SPEC §Match structure */
export const MatchConfigSchema = z
  .object({
    matchId: z.string().min(1).max(128),
    mode: ModeSchema,
    /** CLAUDE.md invariant 11: party matches are tagged and excluded from detection metrics. */
    isParty: z.boolean(),
    seats: z.array(SeatConfigSchema).length(SEAT_COUNT),
  })
  .refine((c) => c.seats.every((s, i) => s.seatId === i), {
    message: 'seats must be listed in seatId order 0..5',
  })
  .refine((c) => c.seats.filter((s) => s.isAgent).length <= MAX_AGENTS, {
    message: `a match seats at most ${MAX_AGENTS} agents`,
  });
export type MatchConfig = z.infer<typeof MatchConfigSchema>;

export const SeedSchema = z.string().min(1).max(256);
