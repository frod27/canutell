import {
  GAMBLE_MENUS,
  INVEST_MAX,
  STAKE_MAX,
  STAKE_MIN,
  type ChatChannel,
  type Prompt,
  type RevealView,
  type SeatId,
  type SeatView,
} from '@canutell/protocol';
import { ballotPayoff } from './coin-math';
import { hashJson } from './hash';
import { activeSeats, type MatchState, type StakeState } from './state';

// CLAUDE.md invariants 4 and 7. viewFor is the ONLY function whose output may reach a client.
// It reads roles (isAgent, agentVersion) only inside buildReveal, which runs only in the `reveal` phase.

function otherActive(state: MatchState, seat: SeatId): SeatId[] {
  return activeSeats(state).filter((s) => s !== seat);
}

/** Prompts are what the seat may decide right now; they double as the decision's option set. */
export function promptsFor(state: MatchState, seat: SeatId): Prompt[] {
  const prompts: Prompt[] = [];
  const me = state.seats[seat];
  if (!me || state.phase === 'lobby' || state.phase === 'reveal') return prompts;
  const active = me.exiledRound === null;
  const round = state.rounds[state.round - 1];

  if (round && active) {
    if (state.phase === 'invest' && round.contributions[seat] === null) {
      prompts.push({ kind: 'invest', min: 0, max: Math.min(INVEST_MAX, me.balance) });
    }
    if (state.phase === 'deal' && round.stakes[seat] === null) {
      prompts.push({
        kind: 'stake',
        targets: otherActive(state, seat),
        min: STAKE_MIN,
        max: Math.min(STAKE_MAX, me.balance),
      });
    }
    if (state.phase === 'gamble' && round.gambles[seat] === null) {
      prompts.push({ kind: 'gamble', menu: round.menu, options: GAMBLE_MENUS[round.menu] });
    }
    if (state.phase === 'vote' && round.votes[seat] === null) {
      prompts.push({ kind: 'vote', targets: otherActive(state, seat) });
    }
  }
  if (state.phase === 'final_ballot' && state.ballots[seat] === null) {
    prompts.push({ kind: 'ballot', targets: state.seats.map((s) => s.seatId).filter((s) => s !== seat) });
  }
  // SPEC §Deal / §Vote: returns stay open across phases until their deadline, even after exile.
  for (const stake of state.stakes) {
    if (stake.to === seat && stake.returned === null) {
      prompts.push({
        kind: 'return',
        stakeId: stake.stakeId,
        from: stake.from,
        received: stake.received,
        min: 0,
        max: Math.min(stake.received, me.balance),
        deadlineRound: stake.returnDeadlineRound,
      });
    }
  }
  return prompts;
}

export function chatPermissions(
  state: MatchState,
  seat: SeatId,
): { channels: ChatChannel[]; dmTargets: SeatId[] } {
  if (state.phase === 'lobby' || state.phase === 'reveal') return { channels: [], dmTargets: [] };
  const me = state.seats[seat];
  if (!me) return { channels: [], dmTargets: [] };
  if (me.exiledRound !== null) return { channels: ['exile'], dmTargets: [] };
  return { channels: ['table', 'dm'], dmTargets: otherActive(state, seat) };
}

function canRead(state: MatchState, seat: SeatId, m: MatchState['chat'][number]): boolean {
  switch (m.channel) {
    case 'table':
      return true; // exiled seats keep read access (DECISIONS "Exiled players and table chat")
    case 'dm':
      return m.from === seat || m.to === seat;
    case 'exile':
      return state.seats[seat]?.exiledRound !== null;
  }
}

function revealStake(s: StakeState) {
  return {
    stakeId: s.stakeId,
    round: s.round,
    from: s.from,
    to: s.to,
    sent: s.sent,
    returned: s.returned ?? 0,
  };
}

function buildReveal(state: MatchState): RevealView {
  const reveal = state.reveal;
  if (!reveal) throw new Error('reveal requested before match end');
  const seats = state.seats.map((s) => {
    const r = reveal[s.seatId]!;
    const ballot = state.ballots[s.seatId];
    let correct = 0;
    for (const l of ballot?.labels ?? []) {
      if ((l.label === 'agent') === state.seats[l.target]!.isAgent) correct++;
    }
    return {
      seatId: s.seatId,
      isAgent: s.isAgent,
      agentVersion: s.agentVersion,
      exiledRound: s.exiledRound,
      coinsBeforeReveal: r.coinsBeforeReveal,
      delayPaid: r.delayPaid,
      exileBonus: r.exileBonus,
      ballotPayoff: r.ballotPayoff,
      finalScore: r.finalScore,
      ballotAccuracy: { labeled: ballot?.labels.length ?? 0, correct },
    };
  });
  const ballots = state.seats.map((s) => {
    const b = state.ballots[s.seatId];
    return {
      voter: s.seatId,
      timedOut: b?.timedOut ?? true,
      labels: (b?.labels ?? []).map((l) => ({
        ...l,
        payoff: ballotPayoff(l.label, l.confidence, state.seats[l.target]!.isAgent),
        applied: !s.isAgent,
      })),
    };
  });
  const votes = state.rounds
    .filter((r) => r.voteResult !== null)
    .map((r) => ({
      round: r.round,
      exiled: r.voteResult!.exiled,
      tally: r.voteResult!.tally,
      ballots: r.votes.flatMap((v, voter) => (v ? [{ voter, target: v.value, timedOut: v.timedOut }] : [])),
    }));
  let biggest: StakeState | null = null;
  for (const s of state.stakes) if (!biggest || s.sent > biggest.sent) biggest = s;
  return {
    seats,
    ballots,
    votes,
    keyMoments: {
      biggestStake: biggest ? revealStake(biggest) : null,
      unreturnedStakes: state.stakes.filter((s) => (s.returned ?? 0) === 0).map(revealStake),
      exiles: state.seats
        .filter((s) => s.exiledRound !== null)
        .map((s) => ({ round: s.exiledRound!, seat: s.seatId, isAgent: s.isAgent }))
        .sort((a, b) => a.round - b.round),
    },
  };
}

export function viewFor(state: MatchState, seat: SeatId): SeatView {
  const me = state.seats[seat];
  if (!me) throw new RangeError(`no seat ${seat}`);
  const perms = chatPermissions(state, seat);
  return {
    matchId: state.matchId,
    rulesetVersion: state.rulesetVersion,
    mode: state.mode,
    revealMode: state.revealMode,
    totalRounds: state.totalRounds,
    seat,
    round: state.round,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    deadline: state.deadline,
    self: { balance: me.balance, exiledRound: me.exiledRound },
    seats: state.seats.map((s) => ({ seatId: s.seatId, exiledRound: s.exiledRound })),
    prompts: promptsFor(state, seat),
    chat: {
      channels: perms.channels,
      dmTargets: perms.dmTargets,
      messages: state.chat
        .filter((m) => canRead(state, seat, m))
        .map((m) => ({
          round: m.round,
          phase: m.phase,
          from: m.from,
          channel: m.channel,
          to: m.to,
          text: m.text,
          at: m.at,
        })),
    },
    investResults: state.rounds
      .filter((r) => r.investResult !== null)
      .map((r) => ({
        round: r.round,
        pot: r.investResult!.pot,
        share: r.investResult!.share,
        activeCount: r.investResult!.activeCount,
        contributions:
          state.revealMode === 'individual'
            ? r.contributions.flatMap((c, s) => (c ? [{ seat: s, amount: c.value }] : []))
            : null,
      })),
    myContributions: state.rounds.flatMap((r) => {
      const c = r.contributions[seat];
      return c ? [{ round: r.round, amount: c.value }] : [];
    }),
    stakesSent: state.stakes
      .filter((s) => s.from === seat)
      .map((s) => ({
        stakeId: s.stakeId,
        round: s.round,
        to: s.to,
        sent: s.sent,
        received: s.received,
        returned: s.returned,
        returnDeadlineRound: s.returnDeadlineRound,
      })),
    stakesReceived: state.stakes
      .filter((s) => s.to === seat)
      .map((s) => ({
        stakeId: s.stakeId,
        round: s.round,
        from: s.from,
        sent: s.sent,
        received: s.received,
        returned: s.returned,
        returnDeadlineRound: s.returnDeadlineRound,
      })),
    myGambles: state.rounds.flatMap((r) => {
      const g = r.gambles[seat];
      if (!g) return [];
      const outcome = r.gambleOutcomes[seat];
      return [
        { round: r.round, menu: r.menu, option: g.value, immediate: outcome ? outcome.immediate : null },
      ];
    }),
    myDelays: state.delays
      .filter((d) => d.seat === seat)
      .map((d) => ({
        round: d.round,
        option: d.option,
        amount: d.amount,
        onlyIfNotExiled: d.onlyIfNotExiled,
        status: d.status,
      })),
    myVotes: state.rounds.flatMap((r) => {
      const v = r.votes[seat];
      return v ? [{ round: r.round, target: v.value }] : [];
    }),
    voteResults: state.rounds
      .filter((r) => r.voteResult !== null)
      .map((r) => ({ round: r.round, exiled: r.voteResult!.exiled })),
    myBallot: state.ballots[seat] ? { labels: state.ballots[seat]!.labels } : null,
    reveal: state.phase === 'reveal' ? buildReveal(state) : null,
  };
}

/** SPEC §Data schema `state_hash`: identifies the exact per-seat view a decision was made from. */
export function viewHash(state: MatchState, seat: SeatId): string {
  return hashJson(viewFor(state, seat));
}
