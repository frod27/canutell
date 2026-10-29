import WebSocket from 'ws';
import { Rng } from '@canutell/engine';
import {
  PHASE_DURATION_MS,
  ServerMessageSchema,
  promptKey,
  type ClientEnv,
  type ClientMessage,
  type Mode,
  type ServerMessage,
  type SeatView,
  type TimedPhase,
} from '@canutell/protocol';
import { POLICIES, chatAction, type PolicyName } from './policies';

// A scripted player that connects through the public WebSocket protocol, exactly like a human client
// (CLAUDE.md invariant 15): it only ever sees its own view frames and only sends choices.
//
// Timing: until there is a human latency distribution to sample from (CLAUDE.md invariant 14), bots use a
// placeholder: a skewed draw over the phase, never instant. Matches with scripted bots are flagged.

export interface BotClientOptions {
  url: string;
  /** Pre-issued seat token (agent/filler seats), or null to arrive as a fresh guest. */
  token: string | null;
  policy: PolicyName;
  seed: string;
  /** Virtual ms per real ms — must match the server clock's speed. */
  speed: number;
  /** If set, join this public queue after the welcome. */
  queue?: Mode;
  /** Chance (0–100) a decision is left to time out. */
  timeoutPct?: number;
  /** Every frame received, for audits. */
  onFrame?: (msg: ServerMessage) => void;
  /** Report this environment after the welcome, as the web client does (integrity signals, load tests). */
  env?: ClientEnv;
}

export interface BotResult {
  matchId: string | null;
  seat: number | null;
  rejected: { code: string; message: string }[];
  finalView: SeatView | null;
  closedEarly: boolean;
}

const MIN_REACTION_MS = 800;
const DEADLINE_MARGIN_MS = 1500;

/** Placeholder reaction time in virtual ms, skewed early; never instant (CLAUDE.md invariant 14). */
export function placeholderLatency(phase: TimedPhase, rng: Rng): number {
  const duration = PHASE_DURATION_MS[phase];
  const u = rng.nextInt(10_000) / 10_000;
  return MIN_REACTION_MS + Math.floor((duration - 2 * MIN_REACTION_MS) * u * u);
}

export class BotClient {
  private ws: WebSocket | null = null;
  private readonly rng: Rng;
  private view: SeatView | null = null;
  private matchId: string | null = null;
  private readonly scheduled = new Set<string>();
  /** Prompt keys already answered: never answer twice, even if a stale view still shows the prompt. */
  private readonly answered = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private actionSeq = 0;
  private chattedIn = new Set<string>();
  private readonly result: BotResult = {
    matchId: null,
    seat: null,
    rejected: [],
    finalView: null,
    closedEarly: false,
  };

  constructor(private readonly o: BotClientOptions) {
    this.rng = Rng.fromSeed(o.seed);
  }

  /** Resolves when the bot has seen Reveal, or its socket closes. */
  run(): Promise<BotResult> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.o.url);
      this.ws = ws;
      ws.on('open', () => this.send({ type: 'hello', token: this.o.token }));
      ws.on('message', (data) => {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) return;
        this.o.onFrame?.(parsed.data);
        this.onMessage(parsed.data);
        if (this.result.finalView) ws.close();
      });
      ws.on('close', () => {
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        if (!this.result.finalView) this.result.closedEarly = true;
        resolve(this.result);
      });
      ws.on('error', () => ws.close());
    });
  }

  /** The match this bot was seated in, if any. */
  get seatedMatchId(): string | null {
    return this.result.matchId;
  }

  close(): void {
    this.ws?.close();
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private later(realMs: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, realMs);
    this.timers.add(t);
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        if (this.o.env) this.send({ type: 'client.env', env: this.o.env });
        if (this.o.queue && !msg.resumedMatchId) this.send({ type: 'queue.join', mode: this.o.queue });
        break;
      case 'match.found':
        this.matchId = msg.matchId;
        this.result.matchId = msg.matchId;
        this.result.seat = msg.seat;
        break;
      case 'view':
        this.matchId = msg.matchId;
        this.view = msg.view;
        if (msg.view.phase === 'reveal') {
          this.result.finalView = msg.view;
          return;
        }
        this.plan(msg.view, msg.serverTime);
        break;
      case 'action.rejected':
        this.result.rejected.push({ code: msg.code, message: msg.message });
        break;
      default:
        break;
    }
  }

  /** Schedule a decision for each prompt not yet handled. */
  private plan(view: SeatView, serverTime: number): void {
    if (view.phase === 'lobby' || view.phase === 'reveal' || view.deadline === null) return;
    const phase = view.phase as TimedPhase;
    const remaining = view.deadline - serverTime;
    for (const p of view.prompts) {
      const key = promptKey(p, view.round);
      // Returns may be deferred to a later phase: decide once per phase whether to act now.
      const handleKey = p.kind === 'return' ? `${key}@${view.round}:${phase}` : key;
      if (this.scheduled.has(handleKey)) continue;
      this.scheduled.add(handleKey);
      if (this.rng.nextInt(100) < (this.o.timeoutPct ?? 5)) continue;
      if (p.kind === 'return' && this.rng.nextInt(100) >= (phase === 'deal' ? 75 : 35)) continue;
      const delay = Math.min(placeholderLatency(phase, this.rng), remaining - DEADLINE_MARGIN_MS);
      if (delay <= 0) continue;
      this.later(delay / this.o.speed, () => this.act(key));
    }
    const chatKey = `${view.round}:${phase}`;
    const policy = POLICIES[this.o.policy];
    if (!this.chattedIn.has(chatKey)) {
      this.chattedIn.add(chatKey);
      if (this.rng.nextInt(100) < policy.chatPct) {
        const delay = Math.min(placeholderLatency(phase, this.rng), remaining - DEADLINE_MARGIN_MS);
        if (delay > 0) {
          this.later(delay / this.o.speed, () => {
            const v = this.view;
            const action = v ? chatAction(v, this.rng) : null;
            if (action) this.sendAction(action);
          });
        }
      }
    }
  }

  private act(key: string): void {
    const view = this.view;
    if (!view) return;
    const prompt = view.prompts.find((p) => promptKey(p, view.round) === key);
    if (!prompt || this.answered.has(key)) return;
    this.answered.add(key);
    this.sendAction(POLICIES[this.o.policy].choose(prompt, view, this.rng));
  }

  private sendAction(action: Extract<ClientMessage, { type: 'action' }>['action']): void {
    if (!this.matchId) return;
    this.send({
      type: 'action',
      matchId: this.matchId,
      clientActionId: `a${++this.actionSeq}`,
      action,
      seenPhase: this.view ? { round: this.view.round, phase: this.view.phase } : null,
      clientSentAt: Date.now(), // the client's own clock: stored, never trusted
    });
  }
}
