import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import type { MatchInput } from '@canutell/engine';
import type { DecisionKind, MatchConfig, MatchEvent, Mode, SeatId } from '@canutell/protocol';

// Where a match's records go. Phase 2 writes append-only JSONL files per match; Phase 3 replaces this
// with Postgres behind the same interface (DECISIONS "Phase 2 persistence").
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
 * Data-quality flags. Every Phase 2 match carries `phase2` (not research data).
 * `scripted_agents`: agent seats are played by scripted bots, not trained agents.
 * `bot_fill`: some human seats were filled by bots (dev only).
 * `sped_up`: played on a clock faster than real time (tests, load tests).
 */
export type MatchFlag = 'phase2' | 'scripted_agents' | 'bot_fill' | 'sped_up';

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

export class MemoryStore implements MatchStore {
  readonly matches = new Map<string, StoredMatch>();

  private get(id: string): StoredMatch {
    const m = this.matches.get(id);
    if (!m) throw new Error(`unknown match ${id}`);
    return m;
  }

  open(meta: MatchMeta): void {
    this.matches.set(meta.matchId, {
      meta: { ...meta },
      events: [],
      inputs: [],
      timings: [],
      connections: [],
      rejections: [],
    });
  }
  events(id: string, events: readonly MatchEvent[]): void {
    this.get(id).events.push(...events);
  }
  input(id: string, input: MatchInput): void {
    this.get(id).inputs.push(input);
  }
  timing(id: string, r: TimingRecord): void {
    this.get(id).timings.push(r);
  }
  connection(id: string, r: ConnectionRecord): void {
    this.get(id).connections.push(r);
  }
  rejection(id: string, r: RejectionRecord): void {
    this.get(id).rejections.push(r);
  }
  close(id: string, status: Exclude<MatchStatus, 'running'>, at: number): void {
    const m = this.get(id);
    m.meta.status = status;
    m.meta.endedAt = at;
  }
  async shutdown(): Promise<void> {}
}

const STREAMS = ['events', 'inputs', 'timings', 'connections', 'rejections'] as const;
type StreamName = (typeof STREAMS)[number];

/**
 * Append-only JSONL files: `<dir>/<matchId>/{meta.json, events.jsonl, ...}`. On startup, any match still
 * marked `running` was interrupted by a restart and is marked `aborted` (DECISIONS "Restarts").
 */
export class JsonlStore implements MatchStore {
  private readonly open_ = new Map<string, { meta: MatchMeta; streams: Record<StreamName, WriteStream> }>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const id of readdirSync(dir)) {
      const metaPath = join(dir, id, 'meta.json');
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MatchMeta;
      if (meta.status === 'running') {
        meta.status = 'aborted';
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    }
  }

  private writeMeta(meta: MatchMeta): void {
    writeFileSync(join(this.dir, meta.matchId, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  private write(id: string, stream: StreamName, record: unknown): void {
    const m = this.open_.get(id);
    if (!m) throw new Error(`match ${id} is not open`);
    m.streams[stream].write(JSON.stringify(record) + '\n');
  }

  open(meta: MatchMeta): void {
    const dir = join(this.dir, meta.matchId);
    mkdirSync(dir, { recursive: true });
    this.writeMeta(meta);
    const streams = Object.fromEntries(
      STREAMS.map((s) => [s, createWriteStream(join(dir, `${s}.jsonl`), { flags: 'a' })]),
    ) as Record<StreamName, WriteStream>;
    this.open_.set(meta.matchId, { meta: { ...meta }, streams });
  }
  events(id: string, events: readonly MatchEvent[]): void {
    for (const e of events) this.write(id, 'events', e);
  }
  input(id: string, input: MatchInput): void {
    this.write(id, 'inputs', input);
  }
  timing(id: string, r: TimingRecord): void {
    this.write(id, 'timings', r);
  }
  connection(id: string, r: ConnectionRecord): void {
    this.write(id, 'connections', r);
  }
  rejection(id: string, r: RejectionRecord): void {
    this.write(id, 'rejections', r);
  }
  close(id: string, status: Exclude<MatchStatus, 'running'>, at: number): void {
    const m = this.open_.get(id);
    if (!m) return;
    m.meta.status = status;
    m.meta.endedAt = at;
    this.writeMeta(m.meta);
    for (const s of Object.values(m.streams)) s.end();
    this.open_.delete(id);
  }
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.open_.values()].flatMap((m) =>
        Object.values(m.streams).map((s) => new Promise<void>((resolve) => s.end(resolve))),
      ),
    );
  }

  /** Read a stored match back (used by tests and tooling). */
  static read(dir: string, matchId: string): StoredMatch {
    const base = join(dir, matchId);
    const lines = (name: string) => {
      const p = join(base, `${name}.jsonl`);
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    };
    return {
      meta: JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')),
      events: lines('events'),
      inputs: lines('inputs'),
      timings: lines('timings'),
      connections: lines('connections'),
      rejections: lines('rejections'),
    };
  }
}
