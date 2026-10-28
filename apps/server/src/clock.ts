// The server's only source of time. The engine never reads a clock (CLAUDE.md invariant 2); the server
// reads this one and passes `now` in. Tests use ManualClock; the load test and dev use a sped-up
// ScaledClock (matches played that way are flagged `sped_up` and are not data).

export interface Clock {
  /** Integer server time in ms. Monotonic. */
  now(): number;
  /** Run `fn` once the clock reaches `at` (or as soon after as possible). */
  setTimer(at: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Virtual ms per real ms (1 in production). */
  readonly speed: number;
}

export type TimerHandle = { readonly id: number };

export class ScaledClock implements Clock {
  private readonly realStart = performance.now();
  private readonly origin: number;
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    readonly speed = 1,
    origin = Date.now(),
  ) {
    if (!(speed > 0)) throw new RangeError('speed must be positive');
    this.origin = Math.floor(origin);
  }

  now(): number {
    return this.origin + Math.floor((performance.now() - this.realStart) * this.speed);
  }

  setTimer(at: number, fn: () => void): TimerHandle {
    const handle = { id: ++this.seq };
    const arm = () => {
      const remaining = at - this.now();
      if (remaining <= 0) {
        this.timers.delete(handle.id);
        fn();
        return;
      }
      // Real timers can fire a hair early relative to the floored virtual clock; re-arm until due.
      this.timers.set(handle.id, setTimeout(arm, Math.max(1, Math.ceil(remaining / this.speed))));
    };
    arm();
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    const t = this.timers.get(handle.id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(handle.id);
  }
}

/** Deterministic clock for tests: time moves only when advanced, and due timers fire in order. */
export class ManualClock implements Clock {
  readonly speed = 1;
  private t: number;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(at: number, fn: () => void): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ id, at, fn });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  /** Move time forward by `ms`, firing every timer that comes due, in time order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }

  /** Move time without firing timers — simulates a timer that fires late. */
  jump(ms: number): void {
    this.t += ms;
  }

  /** Jump to the next pending timer and fire it. Returns false if none are pending. */
  next(): boolean {
    const due = [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) return false;
    this.advance(Math.max(0, due.at - this.t));
    return true;
  }

  get pending(): number {
    return this.timers.length;
  }
}
