import { z } from 'zod';

// Closed alpha (Phase 6): the post-match survey and the game-night schedule. Neither ever depends on who
// is queued or seated: the schedule is the same for everyone (CLAUDE.md invariant 7).

export const FEEDBACK_TAGS = [
  'too_long',
  'too_slow',
  'confusing',
  'great_chat',
  'felt_unfair',
  'bugs',
] as const;
export const FeedbackTagSchema = z.enum(FEEDBACK_TAGS);
export type FeedbackTag = z.infer<typeof FeedbackTagSchema>;
export const FEEDBACK_COMMENT_MAX = 500;

/** `POST /api/matches/:id/feedback` (signed-in, seated players only; once per seat). */
export const FeedbackRequestSchema = z.object({
  fun: z.number().int().min(1).max(5),
  tags: z
    .array(FeedbackTagSchema)
    .max(FEEDBACK_TAGS.length)
    .refine((t) => new Set(t).size === t.length, 'duplicate tag'),
  comment: z.string().max(FEEDBACK_COMMENT_MAX).nullable(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/** The next game-night windows (wall-clock epoch ms), from the server's GAME_NIGHTS setting. */
export const GameNightsSchema = z.object({
  /** IANA time zone the windows are defined in, for display. */
  timeZone: z.string(),
  windows: z.array(z.object({ start: z.number(), end: z.number() })).max(10),
});
export type GameNights = z.infer<typeof GameNightsSchema>;

/** Sent instead of a welcome when the server only admits accounts (closed alpha, ACCOUNTS_ONLY). */
export const ACCOUNT_REQUIRED = 'account_required';

/** After this long in the queue the client shows a fixed hint about game nights (never a count). */
export const LONG_WAIT_HINT_MS = 3 * 60_000;
