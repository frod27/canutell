import { z } from 'zod';
import { AccountSummarySchema, ClientEnvSchema } from './accounts';
import { GameNightsSchema } from './alpha';
import { ActionSchema } from './actions';
import { ModeSchema, PhaseSchema, SeatIdSchema, ServerTimeSchema } from './common';
import { RevealViewSchema, SeatViewSchema } from './views';

// WebSocket frames between clients (humans, bots, agents) and the server. Every inbound frame is
// zod-parsed by the server (CLAUDE.md "zod at every boundary"). Agents use exactly these frames
// (CLAUDE.md invariant 15).
//
// Nothing here may reveal roles or the agent count before Reveal (CLAUDE.md invariant 7). That is why
// queue status carries no player counts: "4 humans waiting, match started" would reveal 2 agents.

export const PARTY_CODE_LENGTH = 6;
export const PartyCodeSchema = z
  .string()
  .length(PARTY_CODE_LENGTH)
  .regex(/^[A-Z0-9]+$/);

/** Shown in every lobby before a match (SPEC §Match structure). */
export const AI_DISCLOSURE = 'This match may contain AI players.';

// ---------- client → server ----------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  /**
   * First frame on every connection. `token` is a guest token (resumes that guest and seat) or an account
   * session token (`s_…`, from passkey sign-in). null starts a new guest.
   */
  z.object({ type: z.literal('hello'), token: z.string().min(16).max(128).nullable() }),
  /** Integrity signals (SPEC §Integrity), web client only. Stored only for account holders' seats. */
  z.object({ type: z.literal('client.env'), env: ClientEnvSchema }),
  z.object({ type: z.literal('focus') }),
  z.object({ type: z.literal('blur') }),
  z.object({ type: z.literal('queue.join'), mode: ModeSchema }),
  z.object({ type: z.literal('queue.leave') }),
  z.object({ type: z.literal('party.create'), mode: ModeSchema }),
  z.object({ type: z.literal('party.join'), code: PartyCodeSchema }),
  z.object({ type: z.literal('party.leave') }),
  z.object({ type: z.literal('party.start') }),
  z.object({
    type: z.literal('action'),
    matchId: z.string().min(1).max(128),
    /** Echoed in the ack or rejection. */
    clientActionId: z.string().min(1).max(64),
    /** `action.seat` must be the sender's own seat. */
    action: ActionSchema,
    /**
     * The round and phase of the view the client acted on. If the match has moved past it by the time
     * the frame arrives, the rejection is reported as `late` (DECISIONS "Late actions").
     */
    seenPhase: z.object({ round: z.number().int().nonnegative(), phase: PhaseSchema }).nullable(),
    /** Client clock. Stored separately and never trusted (CLAUDE.md invariant 6). */
    clientSentAt: z.number().nullable(),
    /**
     * Agent seats only: the decision model's confidence in this choice, 0–1 (SPEC §Agents). Stored in
     * agent_annotations. A human seat sending it is rejected (DECISIONS "Agent confidence").
     */
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------- server → client ----------

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    playerId: z.string(),
    token: z.string(),
    serverTime: ServerTimeSchema,
    /** Present when the token resumed a seat in a running match. */
    resumedMatchId: z.string().nullable(),
    /** The player's own account when signed in with a session token; null for guests and bots. */
    account: AccountSummarySchema.nullable(),
    /** Closed alpha: upcoming game nights (the same for everyone), or null when none are scheduled. */
    gameNights: GameNightsSchema.nullable(),
  }),
  /** Deliberately count-free (see header). */
  z.object({
    type: z.literal('queue.status'),
    mode: ModeSchema.nullable(),
    state: z.enum(['searching', 'idle']),
    disclosure: z.string(),
  }),
  z.object({
    type: z.literal('party.state'),
    code: PartyCodeSchema,
    mode: ModeSchema,
    /** Party members are humans the host invited; the party knows its own size anyway. */
    members: z.number().int().min(1).max(6),
    isHost: z.boolean(),
    canStart: z.boolean(),
    disclosure: z.string(),
  }),
  z.object({ type: z.literal('party.closed'), code: PartyCodeSchema, reason: z.string() }),
  z.object({
    type: z.literal('match.found'),
    matchId: z.string(),
    seat: SeatIdSchema,
    mode: ModeSchema,
    disclosure: z.string(),
  }),
  z.object({
    type: z.literal('view'),
    matchId: z.string(),
    /** Increments each time this seat's view changes. */
    viewVersion: z.number().int().nonnegative(),
    serverTime: ServerTimeSchema,
    view: SeatViewSchema,
  }),
  z.object({ type: z.literal('action.ack'), clientActionId: z.string() }),
  z.object({
    type: z.literal('action.rejected'),
    clientActionId: z.string(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number(), serverTime: ServerTimeSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

// ---------- HTTP: reopen a finished match's reveal ----------

/**
 * `GET /api/matches/:id/reveal` with `Authorization: Bearer <token>`. Answered only for a player who held
 * a seat in that match; everyone else gets 404 (no hint that the match exists). Built from the database's
 * derived tables (DECISIONS "Reveal from the database").
 */
export const MatchRevealResponseSchema = z.object({
  matchId: z.string(),
  mode: ModeSchema,
  seat: SeatIdSchema,
  reveal: RevealViewSchema,
  myStakes: z.array(
    z.object({
      stakeId: z.string(),
      round: z.number().int(),
      from: SeatIdSchema,
      to: SeatIdSchema,
      sent: z.number().int(),
      received: z.number().int(),
      returned: z.number().int().nullable(),
    }),
  ),
});
export type MatchRevealResponse = z.infer<typeof MatchRevealResponseSchema>;
