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
import type {
  AnnotationRecord,
  ClientSignalRecord,
  ConnectionRecord,
  MatchMeta,
  MatchStatus,
  MatchStore,
  RejectionRecord,
  StoredMatch,
  TimingRecord,
} from '@canutell/db';
import type { MatchInput } from '@canutell/engine';
import type { MatchEvent } from '@canutell/protocol';

export type {
  AnnotationRecord,
  ConnectionRecord,
  MatchFlag,
  MatchMeta,
  MatchStatus,
  MatchStore,
  RejectionRecord,
  SeatOccupant,
  StoredMatch,
  TimingRecord,
} from '@canutell/db';

// In-process stores. MemoryStore for tests and the load test; JsonlStore for running without a
// database (append-only files per match). PostgresStore lives in @canutell/db.

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
      annotations: [],
      clientSignals: [],
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
  annotation(id: string, r: AnnotationRecord): void {
    this.get(id).annotations.push(r);
  }
  clientSignal(id: string, r: ClientSignalRecord): void {
    this.get(id).clientSignals.push(r);
  }
  close(id: string, status: Exclude<MatchStatus, 'running'>, at: number): void {
    const m = this.get(id);
    m.meta.status = status;
    m.meta.endedAt = at;
  }
  async shutdown(): Promise<void> {}
}

const STREAMS = [
  'events',
  'inputs',
  'timings',
  'connections',
  'rejections',
  'annotations',
  'clientSignals',
] as const;
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
  annotation(id: string, r: AnnotationRecord): void {
    this.write(id, 'annotations', r);
  }
  clientSignal(id: string, r: ClientSignalRecord): void {
    this.write(id, 'clientSignals', r);
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
      annotations: lines('annotations'),
      clientSignals: lines('clientSignals'),
    };
  }
}
