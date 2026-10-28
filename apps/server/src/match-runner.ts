import {
  ActionRejectedError,
  InvariantViolationError,
  advancePhase,
  applyAction,
  createMatch,
  viewFor,
  type MatchInput,
  type MatchState,
  type Transition,
} from '@canutell/engine';
import {
  SEAT_IDS,
  decisionPromptKey,
  type ClientMessage,
  type MatchEvent,
  type SeatId,
  type ServerMessage,
} from '@canutell/protocol';
import type { Clock, TimerHandle } from './clock';
import { PromptTracker } from './prompt-tracker';
import type { MatchMeta, MatchStore } from './store';

/** A seat's outbound channel. `send` returns false if nothing was delivered (socket gone). */
export interface SeatLink {
  send(msg: ServerMessage): boolean;
}

type ActionFrame = Extract<ClientMessage, { type: 'action' }>;

export interface MatchRunnerDeps {
  clock: Clock;
  store: MatchStore;
  onEnd(runner: MatchRunner, status: 'completed' | 'aborted'): void;
  log?: (msg: string) => void;
}

/**
 * Owns one live match: feeds validated choices and deadlines to the engine (CLAUDE.md invariant 5),
 * writes every event/input/timing to the store, and pushes each seat its own view.
 *
 * A seat receives a new view only when *its* view changed. Pushing on every transition would tell a
 * seat that somebody else just acted (e.g. a private stake between others) — a timing side channel
 * (DECISIONS "View pushes").
 */
export class MatchRunner {
  state!: MatchState;
  private readonly links: (SeatLink | null)[] = SEAT_IDS.map(() => null);
  private readonly lastView: (string | null)[] = SEAT_IDS.map(() => null);
  private readonly viewVersion: number[] = SEAT_IDS.map(() => 0);
  private readonly prompts = new PromptTracker();
  private timer: TimerHandle | null = null;
  private ended = false;

  constructor(
    readonly meta: MatchMeta,
    private readonly deps: MatchRunnerDeps,
  ) {}

  get matchId(): string {
    return this.meta.matchId;
  }

  get isOver(): boolean {
    return this.ended;
  }

  start(): void {
    this.deps.store.open(this.meta);
    this.state = createMatch(this.meta.config, this.meta.seed).state;
    this.advance();
  }

  /** Attach (or re-attach) a seat's socket and send it its current view. */
  attach(seat: SeatId, link: SeatLink): void {
    this.links[seat] = link;
    this.lastView[seat] = null; // force a resend
    if (!this.ended)
      this.deps.store.connection(this.matchId, { seat, state: 'connected', at: this.deps.clock.now() });
    this.pushView(seat);
  }

  detach(seat: SeatId): void {
    if (this.links[seat] === null) return;
    this.links[seat] = null;
    if (!this.ended)
      this.deps.store.connection(this.matchId, { seat, state: 'disconnected', at: this.deps.clock.now() });
  }

  handleAction(seat: SeatId, frame: ActionFrame): void {
    const link = this.links[seat];
    const reply = (msg: ServerMessage) => link?.send(msg);
    const reject = (code: string, message: string, engineCode: string | null = null) => {
      reply({ type: 'action.rejected', clientActionId: frame.clientActionId, code, message });
      if (!this.ended) {
        this.deps.store.rejection(this.matchId, {
          seat,
          at: this.deps.clock.now(),
          code,
          engineCode,
          actionType: frame.action.type,
        });
      }
    };
    if (frame.matchId !== this.matchId) return reject('wrong_match', 'not your current match');
    if (frame.action.seat !== seat) return reject('not_your_seat', `you are seat ${seat}`);
    if (this.ended) return reject('match_over', 'the match is over');

    const now = this.deps.clock.now();
    let t: Transition;
    try {
      t = applyAction(this.state, frame.action, now);
    } catch (e) {
      if (e instanceof ActionRejectedError) {
        // The client acted on a phase that has since ended: to the player, that is simply late.
        const seen = frame.seenPhase;
        const moved = seen !== null && (seen.round !== this.state.round || seen.phase !== this.state.phase);
        if (moved && e.code !== 'late')
          return reject('late', `the ${seen.phase} phase you acted on has ended`, e.code);
        return reject(e.code, e.message, e.code);
      }
      if (e instanceof InvariantViolationError) return this.abort(e);
      throw e;
    }
    this.commit(t, { kind: 'action', action: frame.action, now }, (event) => ({
      receivedAt: now,
      clientSentAt: event.seat === seat ? frame.clientSentAt : null,
    }));
    reply({ type: 'action.ack', clientActionId: frame.clientActionId });
    this.broadcast();
  }

  /** Called by the deadline timer (and once at start). */
  private advance(): void {
    this.timer = null;
    if (this.ended) return;
    const now = this.deps.clock.now();
    if (this.state.deadline !== null && now < this.state.deadline) {
      this.schedule();
      return;
    }
    let t: Transition;
    try {
      t = advancePhase(this.state, now);
    } catch (e) {
      if (e instanceof InvariantViolationError) return this.abort(e);
      throw e;
    }
    this.commit(t, { kind: 'advance', now }, () => ({ receivedAt: null, clientSentAt: null }));
    this.broadcast();
    if (this.state.phase === 'reveal') this.finish('completed');
    else this.schedule();
  }

  private schedule(): void {
    if (this.state.deadline === null) return;
    if (this.timer) this.deps.clock.clearTimer(this.timer);
    this.timer = this.deps.clock.setTimer(this.state.deadline, () => this.advance());
  }

  /** Persist a transition. Timings are recorded before any new view is pushed (prompts still tracked). */
  private commit(
    t: Transition,
    input: MatchInput,
    timing: (e: MatchEvent) => { receivedAt: number | null; clientSentAt: number | null },
  ): void {
    this.state = t.state;
    const store = this.deps.store;
    store.input(this.matchId, input);
    store.events(this.matchId, t.events);
    for (const e of t.events) {
      if (e.type !== 'decision') continue;
      const seat = e.seat!;
      const key = decisionPromptKey(e.payload);
      const promptSentAt = this.prompts.take(seat, key);
      const { receivedAt, clientSentAt } = timing(e);
      store.timing(this.matchId, {
        seq: e.seq,
        seat,
        kind: e.payload.kind,
        promptKey: key,
        timedOut: e.payload.timedOut,
        promptSentAt,
        receivedAt: e.payload.timedOut ? null : receivedAt,
        latencyMs:
          !e.payload.timedOut && receivedAt !== null && promptSentAt !== null
            ? receivedAt - promptSentAt
            : null,
        clientSentAt: e.payload.timedOut ? null : clientSentAt,
      });
    }
  }

  private broadcast(): void {
    for (const seat of SEAT_IDS) this.pushView(seat);
  }

  private pushView(seat: SeatId): void {
    const link = this.links[seat];
    if (!link || !this.state) return;
    const view = viewFor(this.state, seat);
    const json = JSON.stringify(view);
    if (json === this.lastView[seat]) return;
    const now = this.deps.clock.now();
    const delivered = link.send({
      type: 'view',
      matchId: this.matchId,
      viewVersion: ++this.viewVersion[seat]!,
      serverTime: now,
      view,
    });
    if (!delivered) return;
    this.lastView[seat] = json;
    this.prompts.onViewSent(seat, view, now);
  }

  private finish(status: 'completed' | 'aborted'): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) this.deps.clock.clearTimer(this.timer);
    this.timer = null;
    this.deps.store.close(this.matchId, status, this.deps.clock.now());
    this.deps.onEnd(this, status);
  }

  private abort(e: InvariantViolationError): void {
    this.deps.log?.(`match ${this.matchId} aborted: ${e.message}`);
    for (const link of this.links)
      link?.send({ type: 'error', code: 'match_aborted', message: 'internal error' });
    this.finish('aborted');
  }

  /** Abort without an engine error (server shutdown). */
  shutdown(): void {
    if (this.ended) return;
    for (const link of this.links)
      link?.send({ type: 'error', code: 'match_aborted', message: 'server shutting down' });
    this.finish('aborted');
  }
}
