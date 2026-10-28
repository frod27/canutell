import type {
  Action,
  MatchConfig,
  MatchEvent,
  Mode,
  Prompt,
  RevealMode,
  SeatId,
  SeatView,
  TimedPhase,
} from '@canutell/protocol';
import { expect } from 'vitest';
import {
  ActionRejectedError,
  advancePhase,
  applyAction,
  createMatch,
  viewFor,
  type Rng,
  type MatchInput,
  type MatchState,
  type RejectionCode,
} from '../src';

export const T0 = 1_000_000;

export function makeConfig(
  opts: { mode?: Mode; agents?: SeatId[]; matchId?: string; isParty?: boolean } = {},
): MatchConfig {
  const agents = new Set(opts.agents ?? []);
  return {
    matchId: opts.matchId ?? 'm-test',
    mode: opts.mode ?? 'full',
    isParty: opts.isParty ?? false,
    seats: [0, 1, 2, 3, 4, 5].map((seatId) => ({
      seatId,
      isAgent: agents.has(seatId),
      agentVersion: agents.has(seatId) ? 'baseline-0' : null,
    })),
  };
}

const seedCache = new Map<RevealMode, string>();
/** A seed whose seeded reveal-mode draw yields `mode`. */
export function seedWithRevealMode(mode: RevealMode): string {
  const cached = seedCache.get(mode);
  if (cached) return cached;
  for (let i = 0; ; i++) {
    const seed = `seed-${i}`;
    if (createMatch(makeConfig(), seed).state.revealMode === mode) {
      seedCache.set(mode, seed);
      return seed;
    }
  }
}

/** Test driver: owns a match, a monotonic clock, the event log and the input log. */
export class Driver {
  state: MatchState;
  events: MatchEvent[] = [];
  inputs: MatchInput[] = [];
  t = T0;

  constructor(
    readonly config: MatchConfig = makeConfig(),
    readonly seed: string = 'seed-0',
  ) {
    this.state = createMatch(config, seed).state;
    this.advanceAt(T0);
  }

  private advanceAt(now: number): MatchEvent[] {
    this.t = now;
    const r = advancePhase(this.state, now);
    this.inputs.push({ kind: 'advance', now });
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }

  get phase() {
    return this.state.phase;
  }
  get round() {
    return this.state.round;
  }

  act(action: Action, dt = 1): MatchEvent[] {
    this.t += dt;
    const r = applyAction(this.state, action, this.t);
    this.inputs.push({ kind: 'action', action, now: this.t });
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }

  /** Expect rejection with `code`; the state must be unchanged. */
  reject(action: Action, code: RejectionCode, now = this.t + 1): void {
    const before = JSON.stringify(this.state);
    try {
      applyAction(this.state, action, now);
    } catch (e) {
      expect(e).toBeInstanceOf(ActionRejectedError);
      expect((e as ActionRejectedError).code).toBe(code);
      expect(JSON.stringify(this.state)).toBe(before);
      return;
    }
    throw new Error(`expected rejection ${code} for ${JSON.stringify(action)}`);
  }

  /** Jump to the current deadline and resolve the phase. */
  endPhase(): MatchEvent[] {
    if (this.state.deadline === null) throw new Error('no deadline');
    return this.advanceAt(this.state.deadline);
  }

  /** End phases (with timeouts for anyone who has not acted) until reaching `phase` of `round`. */
  goTo(phase: TimedPhase | 'reveal', round?: number): void {
    for (let guard = 0; guard < 100; guard++) {
      if (this.state.phase === phase && (round === undefined || this.state.round === round)) return;
      if (this.state.phase === 'reveal') throw new Error(`never reached ${phase} ${round}`);
      this.endPhase();
    }
    throw new Error('goTo did not terminate');
  }

  view(seat: SeatId): SeatView {
    return viewFor(this.state, seat);
  }

  balance(seat: SeatId): number {
    return this.state.seats[seat]!.balance;
  }

  eventsOf<T extends MatchEvent['type']>(type: T): Extract<MatchEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);
  }

  decisions(kind?: string) {
    return this.eventsOf('decision').filter((e) => kind === undefined || e.payload.kind === kind);
  }

  /** Exile `target` in the current Vote phase using votes from `voters`, everyone else skips. */
  exile(target: SeatId, voters: SeatId[]): void {
    if (this.state.phase !== 'vote') throw new Error('not in vote');
    for (const v of voters) this.act({ type: 'vote', seat: v, target });
    this.endPhase();
  }
}

export const ALL: SeatId[] = [0, 1, 2, 3, 4, 5];

/**
 * Plays the current phase with seeded random choices from each seat's prompts (and some chat),
 * then ends it. Choices depend only on views, never on roles. `skipPct` leaves decisions to time out.
 */
export function playPhaseRandomly(
  d: Driver,
  rng: Rng,
  opts: { skipPct?: number; chatPct?: number; onStep?: () => void } = {},
): void {
  const skipPct = opts.skipPct ?? 15;
  const chatPct = opts.chatPct ?? 20;
  const start = d.state.phaseStartedAt!;
  const deadline = d.state.deadline!;
  const intents: { at: number; seat: SeatId; action: Action }[] = [];
  for (const seat of ALL) {
    const v = d.view(seat);
    for (const p of v.prompts) {
      if (rng.nextInt(100) < skipPct) continue;
      const at = start + 1 + rng.nextInt(deadline - start - 1);
      intents.push({ at, seat, action: randomChoice(p, seat, rng) });
    }
    if (v.chat.channels.length > 0 && rng.nextInt(100) < chatPct) {
      const channel = rng.pick(v.chat.channels);
      const to = channel === 'dm' ? (v.chat.dmTargets.length ? rng.pick(v.chat.dmTargets) : null) : null;
      if (channel !== 'dm' || to !== null) {
        const text = rng.pick(['hi', 'I will invest 20', 'trust me', 'call 555 123 4567', 'who is the bot?']);
        intents.push({
          at: start + 1 + rng.nextInt(deadline - start - 1),
          seat,
          action: { type: 'chat', seat, channel, to, text, client: null },
        });
      }
    }
  }
  intents.sort((a, b) => a.at - b.at || a.seat - b.seat);
  for (const i of intents) {
    const now = Math.max(i.at, d.t);
    try {
      d.act(i.action, now - d.t);
    } catch (e) {
      // A seat may lack balance after an earlier action in the same phase (e.g. return then invest).
      if (!(e instanceof ActionRejectedError)) throw e;
    }
    opts.onStep?.();
  }
  d.endPhase();
  opts.onStep?.();
}

function randomChoice(p: Prompt, seat: SeatId, rng: Rng): Action {
  switch (p.kind) {
    case 'invest':
      return { type: 'invest', seat, amount: rng.nextInt(p.max + 1) };
    case 'stake':
      if (p.max < p.min || p.targets.length === 0 || rng.nextInt(4) === 0)
        return { type: 'stake', seat, to: null, amount: 0 };
      return { type: 'stake', seat, to: rng.pick(p.targets), amount: p.min + rng.nextInt(p.max - p.min + 1) };
    case 'return':
      return { type: 'return', seat, stakeId: p.stakeId, amount: rng.nextInt(p.max + 1) };
    case 'gamble':
      return { type: 'gamble', seat, option: rng.pick(['A', 'B', 'C'] as const) };
    case 'vote':
      return { type: 'vote', seat, target: rng.nextInt(3) === 0 ? null : rng.pick(p.targets) };
    case 'ballot':
      return {
        type: 'ballot',
        seat,
        labels: p.targets
          .filter(() => rng.nextInt(5) !== 0)
          .map((target) => ({
            target,
            label: rng.pick(['agent', 'human'] as const),
            confidence: 50 + rng.nextInt(51),
          })),
      };
  }
}

export function playMatchRandomly(
  d: Driver,
  rng: Rng,
  opts: Parameters<typeof playPhaseRandomly>[2] = {},
): void {
  while (d.phase !== 'reveal') playPhaseRandomly(d, rng, opts);
}
