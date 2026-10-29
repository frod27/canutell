import { createMatch, type MatchInput } from '@canutell/engine';
import type { MatchEvent } from '@canutell/protocol';
import { applyMatchTrust } from './accounts';
import { insertRows, iso, rebuildDerived } from './queries';
import type { Sql } from './sql';
import type {
  AnnotationRecord,
  ClientSignalRecord,
  ConnectionRecord,
  MatchMeta,
  MatchStatus,
  MatchStore,
  RejectionRecord,
  TimingRecord,
} from './types';

// Writes a live match to Postgres (DECISIONS "Phase 3 write path").
//
// The store interface is synchronous (the match runner must never wait on I/O), so writes are queued per
// match and flushed in order: everything recorded during one engine transition is buffered in the same
// tick and committed in ONE transaction. The database therefore always holds the log up to the last
// completed transition, never half of one. Failed flushes retry with backoff without reordering; if a
// batch still fails, it is reported through onError and later batches for that match are held back
// (writing them would leave a gap in the append-only log).

type Op =
  | { t: 'open'; meta: MatchMeta }
  | { t: 'events'; events: readonly MatchEvent[] }
  | { t: 'input'; idx: number; input: MatchInput }
  | { t: 'timing'; r: TimingRecord }
  | { t: 'connection'; idx: number; r: ConnectionRecord }
  | { t: 'rejection'; idx: number; r: RejectionRecord }
  | { t: 'annotation'; r: AnnotationRecord }
  | { t: 'clientSignal'; idx: number; r: ClientSignalRecord }
  | { t: 'close'; status: Exclude<MatchStatus, 'running'>; at: number };

interface Lane {
  buffer: Op[];
  scheduled: boolean;
  chain: Promise<void>;
  failed: boolean;
  inputs: number;
  connections: number;
  rejections: number;
  signals: number;
}

export interface PostgresStoreOptions {
  /** Called when a batch fails permanently or derivation fails. Default: console.error. */
  onError?: (matchId: string, error: unknown) => void;
  /** Retry delays in ms for a failed batch. */
  retryDelaysMs?: readonly number[];
}

export class PostgresStore implements MatchStore {
  private readonly lanes = new Map<string, Lane>();
  private inflight = 0;
  private idle: (() => void)[] = [];
  private readonly onError: (matchId: string, error: unknown) => void;
  private readonly retryDelays: readonly number[];

  constructor(
    private readonly sql: Sql,
    opts: PostgresStoreOptions = {},
  ) {
    this.onError = opts.onError ?? ((id, e) => console.error(`[db] match ${id}:`, e));
    this.retryDelays = opts.retryDelaysMs ?? [100, 400, 1_600, 6_400];
  }

  /** Mark matches left `running` by a crash or restart as aborted (startup recovery). */
  static async recover(sql: Sql, now: number): Promise<number> {
    const rows = await sql.query<{ match_id: string }>(
      `update matches set status = 'aborted', ended_at = $1::timestamptz where status = 'running' returning match_id`,
      [iso(now)],
    );
    return rows.length;
  }

  private lane(id: string): Lane {
    let l = this.lanes.get(id);
    if (!l) {
      l = {
        buffer: [],
        scheduled: false,
        chain: Promise.resolve(),
        failed: false,
        inputs: 0,
        connections: 0,
        rejections: 0,
        signals: 0,
      };
      this.lanes.set(id, l);
    }
    return l;
  }

  private push(id: string, op: Op): void {
    const l = this.lane(id);
    l.buffer.push(op);
    if (l.scheduled) return;
    l.scheduled = true;
    this.inflight++;
    queueMicrotask(() => {
      l.scheduled = false;
      const batch = l.buffer.splice(0);
      l.chain = l.chain
        .then(() => (batch.length > 0 ? this.flush(id, l, batch) : undefined))
        .finally(() => {
          if (--this.inflight === 0) for (const r of this.idle.splice(0)) r();
        });
    });
  }

  private async flush(id: string, lane: Lane, batch: Op[]): Promise<void> {
    if (lane.failed) {
      this.onError(id, new Error(`dropped ${batch.length} ops after an earlier permanent failure`));
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.sql.transaction((tx) => this.apply(tx, id, batch));
        break;
      } catch (e) {
        if (attempt >= this.retryDelays.length) {
          lane.failed = true;
          this.onError(id, e);
          return;
        }
        await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
      }
    }
    // On close: derive the tables, flip the status and apply the match to its players' trust in ONE
    // transaction, so `completed` always means the derived rows (and therefore the reveal) exist. If that
    // fails, the status is still recorded and the failure is reported; `pnpm db:derive` can rebuild later
    // (trust is applied only here, once).
    const close = batch.find((o): o is Extract<Op, { t: 'close' }> => o.t === 'close');
    if (close) {
      const setStatus = (tx: Sql) =>
        tx.query('update matches set status = $2 where match_id = $1', [id, close.status]);
      try {
        await this.sql.transaction(async (tx) => {
          await rebuildDerived(tx, id);
          await setStatus(tx);
          await applyMatchTrust(tx, id, close.at);
        });
      } catch (e) {
        this.onError(id, e);
        await setStatus(this.sql).catch((e2) => this.onError(id, e2));
      }
      this.lanes.delete(id);
    }
  }

  private async apply(tx: Sql, id: string, batch: Op[]): Promise<void> {
    for (const op of batch) {
      switch (op.t) {
        case 'open':
          await this.writeOpen(tx, op.meta);
          break;
        case 'events':
          await insertRows(
            tx,
            'events',
            {
              match_id: null,
              seq: null,
              type: null,
              seat_id: null,
              payload: 'jsonb',
              server_ts: 'timestamptz',
            },
            op.events.map((e) => ({
              match_id: id,
              seq: e.seq,
              type: e.type,
              seat_id: e.seat,
              payload: JSON.stringify(e.payload),
              server_ts: iso(e.serverTs),
            })),
          );
          break;
        case 'input':
          await tx.query(
            'insert into match_inputs (match_id, idx, kind, action, now_ms) values ($1, $2, $3, $4::jsonb, $5)',
            [
              id,
              op.idx,
              op.input.kind,
              op.input.kind === 'action' ? JSON.stringify(op.input.action) : null,
              op.input.now,
            ],
          );
          break;
        case 'timing': {
          const r = op.r;
          await tx.query(
            `insert into decision_timings (match_id, seq, seat_id, kind, prompt_key, timed_out, prompt_sent_at,
               received_at, latency_ms, client_sent_at)
             values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10)`,
            [
              id,
              r.seq,
              r.seat,
              r.kind,
              r.promptKey,
              r.timedOut,
              r.promptSentAt === null ? null : iso(r.promptSentAt),
              r.receivedAt === null ? null : iso(r.receivedAt),
              r.latencyMs,
              r.clientSentAt === null ? null : Math.round(r.clientSentAt),
            ],
          );
          break;
        }
        case 'connection':
          await tx.query(
            'insert into connections (match_id, idx, seat_id, state, at) values ($1, $2, $3, $4, $5::timestamptz)',
            [id, op.idx, op.r.seat, op.r.state, iso(op.r.at)],
          );
          break;
        case 'rejection':
          await tx.query(
            `insert into rejections (match_id, idx, seat_id, at, code, engine_code, action_type)
             values ($1, $2, $3, $4::timestamptz, $5, $6, $7)`,
            [id, op.idx, op.r.seat, iso(op.r.at), op.r.code, op.r.engineCode, op.r.actionType],
          );
          break;
        case 'annotation':
          await tx.query(
            'insert into agent_annotations (match_id, seq, seat_id, confidence) values ($1, $2, $3, $4)',
            [id, op.r.seq, op.r.seat, op.r.confidence],
          );
          break;
        case 'clientSignal':
          await tx.query(
            'insert into client_signals (match_id, idx, seat_id, at, kind, value) values ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)',
            [
              id,
              op.idx,
              op.r.seat,
              iso(op.r.at),
              op.r.kind,
              op.r.value === null ? null : JSON.stringify(op.r.value),
            ],
          );
          break;
        case 'close':
          // The status flips together with derivation, after this batch commits (see flush).
          await tx.query(`update matches set ended_at = $2::timestamptz where match_id = $1`, [
            id,
            iso(op.at),
          ]);
          break;
      }
    }
  }

  private async writeOpen(tx: Sql, meta: MatchMeta): Promise<void> {
    // Reveal mode and ruleset come from the engine itself (pure, deterministic from config + seed).
    const engine = createMatch(meta.config, meta.seed).state;
    await tx.query(
      `insert into matches (match_id, created_at, mode, ruleset_version, reveal_mode, agent_count, is_party,
         seed, status, flags, clock_speed)
       values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, 'running', $9::text[], $10)`,
      [
        meta.matchId,
        iso(meta.createdAt),
        meta.mode,
        engine.rulesetVersion,
        engine.revealMode,
        meta.config.seats.filter((s) => s.isAgent).length,
        meta.isParty,
        meta.seed,
        meta.flags,
        meta.clockSpeed,
      ],
    );
    for (const o of meta.occupants) {
      if (o.kind === 'human') {
        await tx.query('insert into players (player_id) values ($1) on conflict (player_id) do nothing', [
          o.playerId,
        ]);
      }
    }
    await insertRows(
      tx,
      'seats',
      {
        match_id: null,
        seat_id: null,
        kind: 'seat_kind',
        player_id: null,
        agent_version: null,
        is_agent: null,
        trust_level_at_match: 'trust_level',
      },
      meta.occupants.map((o) => {
        const cfg = meta.config.seats[o.seat]!;
        return {
          match_id: meta.matchId,
          seat_id: o.seat,
          kind: o.kind,
          player_id: o.kind === 'human' ? o.playerId : null,
          agent_version: cfg.agentVersion,
          is_agent: cfg.isAgent,
          trust_level_at_match: o.kind === 'human' ? (o.trustLevel ?? 'T0') : null,
        };
      }),
    );
  }

  open(meta: MatchMeta): void {
    this.push(meta.matchId, { t: 'open', meta });
  }
  events(id: string, events: readonly MatchEvent[]): void {
    if (events.length > 0) this.push(id, { t: 'events', events: [...events] });
  }
  input(id: string, input: MatchInput): void {
    this.push(id, { t: 'input', idx: this.lane(id).inputs++, input });
  }
  timing(id: string, r: TimingRecord): void {
    this.push(id, { t: 'timing', r });
  }
  connection(id: string, r: ConnectionRecord): void {
    this.push(id, { t: 'connection', idx: this.lane(id).connections++, r });
  }
  rejection(id: string, r: RejectionRecord): void {
    this.push(id, { t: 'rejection', idx: this.lane(id).rejections++, r });
  }
  annotation(id: string, r: AnnotationRecord): void {
    this.push(id, { t: 'annotation', r });
  }
  clientSignal(id: string, r: ClientSignalRecord): void {
    this.push(id, { t: 'clientSignal', idx: this.lane(id).signals++, r });
  }
  close(id: string, status: Exclude<MatchStatus, 'running'>, at: number): void {
    this.push(id, { t: 'close', status, at });
  }

  /** Resolves once every queued write (and derivation) has finished. */
  async drain(): Promise<void> {
    await new Promise<void>((r) => queueMicrotask(r)); // let same-tick writes reach their batch
    if (this.inflight === 0) return;
    await new Promise<void>((r) => this.idle.push(r));
  }

  async shutdown(): Promise<void> {
    await this.drain();
  }
}
