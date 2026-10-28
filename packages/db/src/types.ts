import type { MatchInput } from '@canutell/engine';
import type { DecisionKind, MatchConfig, MatchEvent, Mode, SeatId } from '@canutell/protocol';

// The records a live match produces, and the store interface they are written through. Stores:
// MemoryStore and JsonlStore (apps/server), PostgresStore (this package).
//
// Records per match:
//   meta         — config (with roles), seed, who sat where, data-quality flags, status
//   events       — the engine's append-only event log (CLAUDE.md invariant 8)
//   inputs       — every accepted input with its server time; replay(config, seed, inputs) rebuilds the match
//   timings      — server-measured latency per decision (CLAUDE.md invariant 6) + untrusted client time
//   connections  — connect/disconnect per seat, so a disconnect timeout can be told from an idle one
//   rejections   — rejected actions (late, invalid), which are behavioral data too

export type MatchStatus = 'running' | 'completed' | 'aborted';

/**
 * Data-quality flags. Every match before Phase 5 carries its build phase (`phase2`, `phase3`): dev data,
 * never research-eligible, purged before the closed alpha (DECISIONS "Guest data before accounts").
 * `scripted_agents`: agent seats are played by scripted bots, not trained agents.
 * `bot_fill`: some human seats were filled by bots (dev only).
 * `sped_up`: played on a clock faster than real time (tests, load tests).
 */
export type MatchFlag = 'phase2' | 'phase3' | 'scripted_agents' | 'bot_fill' | 'sped_up';

export interface SeatOccupant {
  seat: SeatId;
  kind: 'human' | 'agent' | 'filler';
  /** Pseudonymous player id for humans, a generated id for bots. Never personal data (invariant 9). */
  playerId: string;
}

export interface MatchMeta {
  matchId: string;
  mode: Mode;
  seed: string;
  isParty: boolean;
  config: MatchConfig;
  occupants: SeatOccupant[];
  flags: MatchFlag[];
  createdAt: number;
  clockSpeed: number;
  status: MatchStatus;
  endedAt: number | null;
}

export interface TimingRecord {
  /** seq of the decision event this measures. */
  seq: number;
  seat: SeatId;
  kind: DecisionKind;
  promptKey: string;
  timedOut: boolean;
  /** First time a view containing the prompt reached the seat; null if it never did (disconnected). */
  promptSentAt: number | null;
  /** Server time the action frame was processed (null for timeouts). */
  receivedAt: number | null;
  /** receivedAt − promptSentAt, server-measured. null for timeouts or never-shown prompts. */
  latencyMs: number | null;
  /** Client-reported send time. Untrusted, stored for comparison only. */
  clientSentAt: number | null;
}

export interface ConnectionRecord {
  seat: SeatId;
  state: 'connected' | 'disconnected';
  at: number;
}

export interface RejectionRecord {
  seat: SeatId;
  at: number;
  /** What the client was told: `late` if the phase it acted on had already ended. */
  code: string;
  /** The engine's own reason (e.g. `wrong_phase`, `stake_closed`), or null for server-level rejections. */
  engineCode: string | null;
  actionType: string;
}

export interface MatchStore {
  open(meta: MatchMeta): void;
  events(matchId: string, events: readonly MatchEvent[]): void;
  input(matchId: string, input: MatchInput): void;
  timing(matchId: string, record: TimingRecord): void;
  connection(matchId: string, record: ConnectionRecord): void;
  rejection(matchId: string, record: RejectionRecord): void;
  close(matchId: string, status: Exclude<MatchStatus, 'running'>, at: number): void;
  /** Flush and release resources. */
  shutdown(): Promise<void>;
}

export interface StoredMatch {
  meta: MatchMeta;
  events: MatchEvent[];
  inputs: MatchInput[];
  timings: TimingRecord[];
  connections: ConnectionRecord[];
  rejections: RejectionRecord[];
}
