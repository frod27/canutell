import {
  ActionRejectedError,
  InvariantViolationError,
  Rng,
  advancePhase,
  applyAction,
  createMatch,
  drawAgentSeats,
  viewFor,
  type MatchInput,
  type MatchState,
} from '@canutell/engine';
import {
  PHASE_DURATION_MS,
  SEAT_IDS,
  type Action,
  type MatchConfig,
  type MatchEvent,
  type Mode,
  type Prompt,
  type SeatId,
  type TimedPhase,
} from '@canutell/protocol';
import { POLICIES, POLICY_NAMES, chatAction, type PolicyName } from './policies';

export interface SimMatchOptions {
  baseSeed: string;
  index: number;
  mode: Mode;
  /** Chance (0–100) that a seat lets a given decision time out. */
  timeoutPct: number;
  /** Relative weights for seating 0, 1, 2 agents. */
  agentWeights: readonly number[];
  /** Record every seat's serialized view at each phase start (for audits). */
  collectViews: boolean;
  /** Override the drawn role layout (used by the hidden-information counterfactual audit). */
  agentsOverride?: boolean[];
}

export interface Rejection {
  seat: SeatId;
  action: Action;
  code: string;
  message: string;
}

export interface SimMatchResult {
  seed: string;
  config: MatchConfig;
  policies: PolicyName[];
  events: MatchEvent[];
  inputs: MatchInput[];
  state: MatchState;
  rejected: Rejection[];
  engineError: { invariant: string; message: string } | null;
  /** phase key → six serialized views, captured at each phase start (if collectViews). */
  phaseViews: { key: string; views: string[] }[];
}

export const SIM_T0 = 1_000;

interface Scheduled {
  at: number;
  order: number;
  seat: SeatId;
  /** Prompt key, or 'chat'. */
  key: string;
}

function promptKey(p: Prompt): string {
  return p.kind === 'return' ? `return:${p.stakeId}` : p.kind;
}

/** Human-ish reaction time: skewed toward the start of the phase, never instant, always before the deadline. */
function latency(phase: TimedPhase, rng: Rng): number {
  const duration = PHASE_DURATION_MS[phase];
  const min = 800;
  const u = rng.nextInt(10_000) / 10_000;
  return min + Math.floor((duration - 2 * min) * u * u);
}

export function simSeed(baseSeed: string, index: number): string {
  return `${baseSeed}:${index}`;
}

export function runMatch(opts: SimMatchOptions): SimMatchResult {
  const seed = simSeed(opts.baseSeed, opts.index);
  const agents = opts.agentsOverride ?? drawAgentSeats(seed, opts.agentWeights);
  const config: MatchConfig = {
    matchId: `sim-${opts.mode}-${opts.index}`,
    mode: opts.mode,
    isParty: false,
    seats: SEAT_IDS.map((seatId) => ({
      seatId,
      isAgent: agents[seatId]!,
      agentVersion: agents[seatId] ? 'sim-bot-0' : null,
    })),
  };
  // Bot randomness is separate from the engine's RNG and never sees roles.
  const rng = Rng.fromSeed(`${seed}:bots`);
  const policies = SEAT_IDS.map(() => rng.pick(POLICY_NAMES));

  let state = createMatch(config, seed).state;
  const events: MatchEvent[] = [];
  const inputs: MatchInput[] = [];
  const rejected: Rejection[] = [];
  const phaseViews: SimMatchResult['phaseViews'] = [];
  let engineError: SimMatchResult['engineError'] = null;

  const advance = (now: number) => {
    const r = advancePhase(state, now);
    inputs.push({ kind: 'advance', now });
    state = r.state;
    events.push(...r.events);
  };

  try {
    advance(SIM_T0);
    while (state.phase !== 'reveal') {
      const phase = state.phase as TimedPhase;
      const start = state.phaseStartedAt!;
      const deadline = state.deadline!;
      if (opts.collectViews) {
        phaseViews.push({
          key: `${state.round}:${phase}`,
          views: SEAT_IDS.map((s) => JSON.stringify(viewFor(state, s))),
        });
      }

      let order = 0;
      const queue: Scheduled[] = [];
      const schedule = (seat: SeatId, key: string, at: number) => {
        if (at < deadline) queue.push({ at, order: order++, seat, key });
      };
      for (const seat of SEAT_IDS) {
        const view = viewFor(state, seat);
        for (const p of view.prompts) {
          if (rng.nextInt(100) < opts.timeoutPct) continue; // let it time out
          // Returns may be deferred to a later phase (still before the deadline round).
          if (p.kind === 'return' && rng.nextInt(100) >= (phase === 'deal' ? 75 : 35)) continue;
          schedule(seat, promptKey(p), start + latency(phase, rng));
        }
        if (rng.nextInt(100) < POLICIES[policies[seat]!].chatPct)
          schedule(seat, 'chat', start + latency(phase, rng));
      }

      while (queue.length > 0) {
        queue.sort((a, b) => a.at - b.at || a.order - b.order);
        const item = queue.shift()!;
        const view = viewFor(state, item.seat);
        let action: Action | null;
        if (item.key === 'chat') {
          action = chatAction(view, rng);
        } else {
          const prompt = view.prompts.find((p) => promptKey(p) === item.key);
          action = prompt ? POLICIES[policies[item.seat]!].choose(prompt, view, rng) : null;
        }
        if (!action) continue;
        const now = Math.max(item.at, state.clock ?? 0);
        try {
          const r = applyAction(state, action, now);
          inputs.push({ kind: 'action', action, now });
          state = r.state;
          events.push(...r.events);
          // A stake that lands mid-Deal opens a return prompt for the receiver.
          for (const e of r.events) {
            if (e.type === 'stake_sent' && rng.nextInt(100) < 60) {
              schedule(e.payload.to, `return:${e.payload.stakeId}`, now + latency(phase, rng));
            }
          }
        } catch (e) {
          if (!(e instanceof ActionRejectedError)) throw e;
          rejected.push({ seat: item.seat, action, code: e.code, message: e.message });
        }
      }
      advance(deadline);
    }
  } catch (e) {
    if (!(e instanceof InvariantViolationError)) throw e;
    engineError = { invariant: e.invariant, message: e.message };
  }

  return { seed, config, policies, events, inputs, state, rejected, engineError, phaseViews };
}
