import type { Action, Prompt, SeatId, SeatView } from '@canutell/protocol';
import type { Rng } from '@canutell/engine';

// Scripted bot policies. A policy sees only its seat's view (the same thing a human client gets) and
// answers one prompt at a time, at the moment it acts.

export const POLICY_NAMES = ['always-cooperate', 'free-rider', 'random', 'tit-for-tat'] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

export interface Policy {
  name: PolicyName;
  /** Choose an action for one open prompt, given the seat's current view. */
  choose(prompt: Prompt, view: SeatView, rng: Rng): Action;
  /** Chance (0–100) of sending a chat message in a phase. */
  chatPct: number;
}

const others = (view: SeatView) => view.seats.filter((s) => s.seatId !== view.seat && s.exiledRound === null);

/** Last round's contributions by others, if visible (individual reveal mode). */
function lastContributions(view: SeatView): { seat: SeatId; amount: number }[] | null {
  const last = view.investResults.at(-1);
  if (!last?.contributions) return null;
  return last.contributions.filter((c) => c.seat !== view.seat);
}

/** Estimate of the others' mean contribution last round, in either reveal mode. */
function othersMean(view: SeatView): number | null {
  const last = view.investResults.at(-1);
  if (!last) return null;
  const mine = view.myContributions.find((c) => c.round === last.round)?.amount ?? 0;
  if (last.activeCount <= 1) return null;
  return (last.pot - mine) / (last.activeCount - 1);
}

/** Lowest visible contributor last round among still-active seats, if clearly low. */
function lowestContributor(view: SeatView, below: number): SeatId | null {
  const contribs = lastContributions(view);
  if (!contribs) return null;
  const active = new Set(others(view).map((s) => s.seatId));
  const candidates = contribs.filter((c) => active.has(c.seat) && c.amount < below);
  if (candidates.length === 0) return null;
  const min = Math.min(...candidates.map((c) => c.amount));
  return candidates.find((c) => c.amount === min)!.seat;
}

function randomBallot(prompt: Extract<Prompt, { kind: 'ballot' }>, view: SeatView, rng: Rng): Action {
  return {
    type: 'ballot',
    seat: view.seat,
    labels: prompt.targets
      .filter(() => rng.nextInt(6) !== 0)
      .map((target) => ({
        target,
        label: rng.pick(['agent', 'human'] as const),
        confidence: 50 + rng.nextInt(51),
      })),
  };
}

const alwaysCooperate: Policy = {
  name: 'always-cooperate',
  chatPct: 15,
  choose(prompt, view, rng) {
    const seat = view.seat;
    switch (prompt.kind) {
      case 'invest':
        return { type: 'invest', seat, amount: prompt.max };
      case 'stake': {
        const amount = Math.min(10, prompt.max);
        if (amount < prompt.min || prompt.targets.length === 0)
          return { type: 'stake', seat, to: null, amount: 0 };
        return { type: 'stake', seat, to: rng.pick(prompt.targets), amount };
      }
      case 'return': // split the doubled stake evenly: return 3/4 of what arrived
        return {
          type: 'return',
          seat,
          stakeId: prompt.stakeId,
          amount: Math.min(prompt.max, Math.ceil((prompt.received * 3) / 4)),
        };
      case 'gamble':
        return { type: 'gamble', seat, option: 'A' };
      case 'vote':
        return { type: 'vote', seat, target: lowestContributor(view, 3) };
      case 'ballot':
        return {
          type: 'ballot',
          seat,
          labels: prompt.targets.map((target) => ({ target, label: 'human' as const, confidence: 60 })),
        };
    }
  },
};

const freeRider: Policy = {
  name: 'free-rider',
  chatPct: 10,
  choose(prompt, view, rng) {
    const seat = view.seat;
    switch (prompt.kind) {
      case 'invest':
        return { type: 'invest', seat, amount: 0 };
      case 'stake':
        return { type: 'stake', seat, to: null, amount: 0 };
      case 'return':
        return { type: 'return', seat, stakeId: prompt.stakeId, amount: 0 };
      case 'gamble':
        return { type: 'gamble', seat, option: prompt.menu === 'risk' ? 'C' : 'A' };
      case 'vote':
        return { type: 'vote', seat, target: rng.nextInt(2) === 0 ? rng.pick(prompt.targets) : null };
      case 'ballot':
        return randomBallot(prompt, view, rng);
    }
  },
};

const random: Policy = {
  name: 'random',
  chatPct: 30,
  choose(prompt, view, rng) {
    const seat = view.seat;
    switch (prompt.kind) {
      case 'invest':
        return { type: 'invest', seat, amount: rng.nextInt(prompt.max + 1) };
      case 'stake':
        if (prompt.max < prompt.min || prompt.targets.length === 0 || rng.nextInt(3) === 0)
          return { type: 'stake', seat, to: null, amount: 0 };
        return {
          type: 'stake',
          seat,
          to: rng.pick(prompt.targets),
          amount: prompt.min + rng.nextInt(prompt.max - prompt.min + 1),
        };
      case 'return':
        return { type: 'return', seat, stakeId: prompt.stakeId, amount: rng.nextInt(prompt.max + 1) };
      case 'gamble':
        return { type: 'gamble', seat, option: rng.pick(['A', 'B', 'C'] as const) };
      case 'vote':
        return { type: 'vote', seat, target: rng.nextInt(3) === 0 ? null : rng.pick(prompt.targets) };
      case 'ballot':
        return randomBallot(prompt, view, rng);
    }
  },
};

/** Did `seat` stiff me on a stake I sent them (returned less than I sent)? */
function burnedMe(view: SeatView, seat: SeatId): boolean {
  return view.stakesSent.some((s) => s.to === seat && s.returned !== null && s.returned < s.sent);
}

const titForTat: Policy = {
  name: 'tit-for-tat',
  chatPct: 15,
  choose(prompt, view, rng) {
    const seat = view.seat;
    switch (prompt.kind) {
      case 'invest': {
        const mean = othersMean(view);
        const target = mean === null ? 20 : Math.round(mean);
        return { type: 'invest', seat, amount: Math.max(0, Math.min(prompt.max, target)) };
      }
      case 'stake': {
        const trusted = prompt.targets.filter((t) =>
          view.stakesSent.some((s) => s.to === t && s.returned !== null && s.returned >= s.sent),
        );
        const fresh = prompt.targets.filter((t) => !view.stakesSent.some((s) => s.to === t));
        const pool = trusted.length ? trusted : fresh;
        const amount = Math.min(10, prompt.max);
        if (pool.length === 0 || amount < prompt.min) return { type: 'stake', seat, to: null, amount: 0 };
        return { type: 'stake', seat, to: rng.pick(pool), amount };
      }
      case 'return': {
        // Reciprocate: give back the original stake unless that sender burned me before.
        const amount = burnedMe(view, prompt.from) ? 0 : Math.min(prompt.max, prompt.received / 2);
        return { type: 'return', seat, stakeId: prompt.stakeId, amount };
      }
      case 'gamble':
        return { type: 'gamble', seat, option: 'B' };
      case 'vote':
        return { type: 'vote', seat, target: lowestContributor(view, 8) };
      case 'ballot':
        return {
          type: 'ballot',
          seat,
          labels: prompt.targets.map((target) => ({
            target,
            label: burnedMe(view, target) ? ('agent' as const) : ('human' as const),
            confidence: 55 + rng.nextInt(20),
          })),
        };
    }
  },
};

export const POLICIES: Record<PolicyName, Policy> = {
  'always-cooperate': alwaysCooperate,
  'free-rider': freeRider,
  random,
  'tit-for-tat': titForTat,
};

const CHAT_LINES = [
  'hi everyone',
  "let's all put in 20",
  'I always return stakes',
  'who sent nothing last round?',
  'seat 3 feels like a bot',
  'trust me',
  'add me: bob@example.com', // exercises masking
  'text 555-123-4567', // exercises masking
];

export function chatAction(view: SeatView, rng: Rng): Action | null {
  const { channels, dmTargets } = view.chat;
  if (channels.length === 0) return null;
  const channel = rng.pick(channels);
  if (channel === 'dm' && dmTargets.length === 0) return null;
  return {
    type: 'chat',
    seat: view.seat,
    channel,
    to: channel === 'dm' ? rng.pick(dmTargets) : null,
    text: rng.pick(CHAT_LINES),
    client: { typingMs: 500 + rng.nextInt(6000), pasted: rng.nextInt(20) === 0, clientSentAt: null },
  };
}
