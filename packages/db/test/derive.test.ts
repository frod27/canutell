import { describe, expect, it } from 'vitest';
import { createMatch, advancePhase, applyAction, type MatchState } from '@canutell/engine';
import type { MatchEvent } from '@canutell/protocol';
import { DerivationError, deriveRows } from '../src';
import { simMatch, timingFor } from './helpers';

// CLAUDE.md invariant 8: derived tables are rebuilt from the log. These tests run without a database.

function logOf(index: number, mode: 'full' | 'quick' = 'quick') {
  const r = simMatch(index, mode);
  let state: MatchState = createMatch(r.config, r.seed).state;
  for (const input of r.inputs) {
    state = (
      input.kind === 'advance' ? advancePhase(state, input.now) : applyAction(state, input.action, input.now)
    ).state;
  }
  const decisions = r.events.filter(
    (e): e is Extract<MatchEvent, { type: 'decision' }> => e.type === 'decision',
  );
  return { r, state, events: r.events, timings: decisions.map(timingFor) };
}

describe('deriveRows', () => {
  it('is a pure function of the log: same input, identical rows', () => {
    const { events, timings } = logOf(1);
    expect(deriveRows('m', events, timings)).toEqual(deriveRows('m', events, timings));
  });

  it('reconciles with the log in every match', () => {
    for (let i = 0; i < 12; i++) {
      const { events, timings, state } = logOf(i, i % 2 ? 'full' : 'quick');
      const rows = deriveRows('m', events, timings);
      // decisions = decision events; latency carried over from the server's timing log
      expect(rows.decisions).toHaveLength(events.filter((e) => e.type === 'decision').length);
      for (const d of rows.decisions)
        expect(d.timed_out ? d.latency_ms === null : d.latency_ms! >= 0).toBe(true);
      // stakes = engine stakes
      expect(
        rows.stakes.map((s) => [s.stake_id, s.sent, s.received, s.returned, s.return_timed_out]),
      ).toEqual(state.stakes.map((s) => [s.stakeId, s.sent, s.received, s.returned, s.returnTimedOut]));
      // messages = chat events, masked text
      expect(rows.messages.map((m) => m.text)).toEqual(state.chat.map((c) => c.text));
      // ballots: 6 voters × 5 targets, blanks explicit with payoff 0
      expect(rows.ballots).toHaveLength(30);
      for (const b of rows.ballots) if (b.label === null) expect([b.confidence, b.payoff]).toEqual([null, 0]);
      // seat results = engine reveal
      expect(
        rows.seatResults.map((s) => [
          s.coins_before_reveal,
          s.delay_paid,
          s.exile_bonus,
          s.ballot_payoff,
          s.final_score,
        ]),
      ).toEqual(
        state.reveal!.map((s) => [
          s.coinsBeforeReveal,
          s.delayPaid,
          s.exileBonus,
          s.ballotPayoff,
          s.finalScore,
        ]),
      );
      expect(rows.seatResults.map((s) => s.exiled_round)).toEqual(state.seats.map((s) => s.exiledRound));
    }
  });

  it('marks decisions on prompts that were never delivered (prompt_seen = false)', () => {
    const { events, timings } = logOf(2);
    const t = timings.map((x, i) => (i === 3 ? { ...x, promptSentAt: null } : x));
    const rows = deriveRows('m', events, t);
    expect(rows.decisions[3]!.prompt_seen).toBe(false);
    expect(rows.decisions.filter((d) => !d.prompt_seen)).toHaveLength(1);
  });

  it('a match that never reached Reveal has no seat results', () => {
    const { events, timings } = logOf(3);
    const cut = events.findIndex((e) => e.type === 'match_ended');
    const partial = events.slice(0, cut - 40);
    const seqs = new Set(partial.map((e) => e.seq));
    const rows = deriveRows(
      'm',
      partial,
      timings.filter((t) => seqs.has(t.seq)),
    );
    expect(rows.seatResults).toEqual([]);
  });

  it('refuses inconsistent logs instead of guessing', () => {
    const { events, timings } = logOf(4);
    expect(() => deriveRows('m', events.slice(1), timings)).toThrow(DerivationError); // gap at seq 0
    expect(() => deriveRows('m', events, timings.slice(1))).toThrow(/timing/);
    const bad = timings.map((t, i) => (i === 0 ? { ...t, timedOut: !t.timedOut } : t));
    expect(() => deriveRows('m', events, bad)).toThrow(/disagrees/);
  });
});
