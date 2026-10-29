import { describe, expect, it } from 'vitest';
import type { MatchEvent, SeatId } from '@canutell/protocol';
import {
  deriveIntegrity,
  INTEGRITY_THRESHOLDS as T,
  type ClientSignalRecord,
  type IntegritySeat,
  type StoredClientEnv,
  type TimingRecord,
} from '../src';

// SPEC §Integrity: automation signals per seat. Thresholds are tested at their boundaries.

const seats: IntegritySeat[] = [
  { seat: 0, kind: 'human', trustLevel: 'T2' },
  { seat: 1, kind: 'human', trustLevel: 'T1' },
  { seat: 2, kind: 'human', trustLevel: 'T0' }, // guest: nothing derived
  { seat: 3, kind: 'agent', trustLevel: null },
  { seat: 4, kind: 'human', trustLevel: 'T2', deleted: true }, // deleted account: like a guest
  { seat: 5, kind: 'filler', trustLevel: null },
];
const clean: StoredClientEnv = {
  webdriver: false,
  headlessUserAgent: false,
  noLanguages: false,
  zeroOuterSize: false,
  serverHeadlessUa: false,
};
let seq = 0;
function chat(
  seat: SeatId,
  at: number,
  text: string,
  o: { channel?: 'table' | 'dm'; to?: SeatId | null; pasted?: boolean } = {},
): MatchEvent {
  return {
    matchId: 'm',
    seq: seq++,
    type: 'chat_message',
    seat,
    serverTs: at,
    payload: {
      round: 1,
      phase: 'deal',
      channel: o.channel ?? 'table',
      to: o.to ?? null,
      text,
      masked: false,
      client: { typingMs: 1000, pasted: o.pasted ?? false, clientSentAt: at },
    },
  } as MatchEvent;
}
const timing = (seat: SeatId, latencyMs: number | null, timedOut = false): TimingRecord => ({
  seq: seq++,
  seat,
  kind: 'invest',
  promptKey: `k${seq}`,
  timedOut,
  promptSentAt: 0,
  receivedAt: latencyMs,
  latencyMs,
  clientSentAt: null,
});
const env = (seat: SeatId, value: StoredClientEnv = clean, at = 0): ClientSignalRecord => ({
  seat,
  at,
  kind: 'env',
  value,
});
const sig = (seat: SeatId, kind: 'focus' | 'blur', at: number): ClientSignalRecord => ({
  seat,
  at,
  kind,
  value: null,
});
function rowsFor(
  input: Partial<Parameters<typeof deriveIntegrity>[0]>,
  seat: SeatId = 0,
): Record<string, { value: number; flagged: boolean }> {
  const rows = deriveIntegrity({ seats, events: [], timings: [], clientSignals: [], ...input });
  return Object.fromEntries(
    rows.filter((r) => r.seat_id === seat).map((r) => [r.signal, { value: r.value, flagged: r.flagged }]),
  );
}

describe('integrity signals (SPEC §Integrity)', () => {
  it('derives nothing for guests and deleted accounts; everything for accounts and bots', () => {
    const rows = deriveIntegrity({ seats, events: [], timings: [], clientSignals: [env(0), env(2)] });
    const bySeat = new Set(rows.map((r) => r.seat_id));
    expect([...bySeat].sort()).toEqual([0, 1, 3, 5]);
  });

  it('no_client_signals flags a seat that never reported its environment (not our web client)', () => {
    expect(rowsFor({ clientSignals: [env(0)] }).no_client_signals).toEqual({ value: 0, flagged: false });
    expect(rowsFor({}).no_client_signals).toEqual({ value: 1, flagged: true });
    // Agents and bots are measured too (it never affects anyone's trust).
    expect(rowsFor({}, 3).no_client_signals!.flagged).toBe(true);
  });

  it('headless flags any headless indicator, from the client or the server', () => {
    expect(rowsFor({ clientSignals: [env(0)] }).headless!.flagged).toBe(false);
    for (const k of Object.keys(clean) as (keyof StoredClientEnv)[])
      expect(rowsFor({ clientSignals: [env(0, { ...clean, [k]: true })] }).headless).toEqual({
        value: 1,
        flagged: true,
      });
  });

  it('latency_cv flags regular timing only with enough decisions', () => {
    const regular = (n: number) => Array.from({ length: n }, (_, i) => timing(0, 5000 + (i % 2) * 100));
    const n = T.latencyMinDecisions;
    expect(rowsFor({ timings: regular(n) }).latency_cv!.flagged).toBe(true);
    expect(rowsFor({ timings: regular(n - 1) }).latency_cv!.flagged).toBe(false);
    // Timeouts and unmeasured prompts don't count.
    expect(rowsFor({ timings: [...regular(n - 1), timing(0, null, true)] }).latency_cv!.flagged).toBe(false);
    // Human-like spread.
    const varied = Array.from({ length: 12 }, (_, i) => timing(0, 2000 + ((i * 3779) % 9000)));
    expect(rowsFor({ timings: varied }).latency_cv!.flagged).toBe(false);
    // Fewer than two measurements: no row at all.
    expect(rowsFor({ timings: [timing(0, 4000)] }).latency_cv).toBeUndefined();
  });

  it('fast_replies counts replies faster than reading the message plus typing the reply', () => {
    const msg = 'one two three four five'; // 5 words → 1200 ms to read
    const reply = 'ok sure'; // 7 chars → 467 ms to type at 15/s
    const needed = Math.ceil(5 * T.readMsPerWord + (reply.length * 1000) / T.typeCharsPerSec); // server times are integer ms
    const exchange = (gap: number, n: number) =>
      Array.from({ length: n }, (_, i) => [
        chat(1, i * 60_000, msg),
        chat(0, i * 60_000 + gap, reply),
      ]).flat();
    expect(rowsFor({ events: exchange(needed - 1, T.fastReplies) }).fast_replies).toEqual({
      value: T.fastReplies,
      flagged: true,
    });
    expect(rowsFor({ events: exchange(needed - 1, T.fastReplies - 1) }).fast_replies!.flagged).toBe(false);
    expect(rowsFor({ events: exchange(needed, T.fastReplies) }).fast_replies!.value).toBe(0);
  });

  it('fast_replies ignores messages already answered and DMs to someone else', () => {
    const events = [
      chat(1, 0, 'hello there'),
      chat(0, 10_000, 'hi'), // answers it, slowly
      chat(0, 10_100, 'how are you'), // not a reply to seat 1's message
      chat(1, 20_000, 'secret', { channel: 'dm', to: 2 }), // not visible to seat 0
      chat(0, 20_050, 'anyone?'),
    ];
    expect(rowsFor({ events }).fast_replies!.value).toBe(0);
    const dm = [chat(1, 0, 'psst', { channel: 'dm', to: 0 }), chat(0, 100, 'yes?')];
    expect(rowsFor({ events: dm }).fast_replies!.value).toBe(1);
  });

  it('pastes and blur_then_paste ("asked another AI") at their thresholds', () => {
    const pastes = (n: number, at0 = 0) =>
      Array.from({ length: n }, (_, i) => chat(0, at0 + i * 1000, 'pasted line', { pasted: true }));
    expect(rowsFor({ events: pastes(T.pastes) }).pastes).toEqual({ value: T.pastes, flagged: true });
    expect(rowsFor({ events: pastes(T.pastes - 1) }).pastes!.flagged).toBe(false);

    const back = 50_000;
    const signals = [env(0), sig(0, 'blur', 40_000), sig(0, 'focus', back)];
    const near = [
      chat(0, back + 1_000, 'a', { pasted: true }),
      chat(0, back + T.blurPasteWindowMs, 'b', { pasted: true }),
    ];
    expect(rowsFor({ events: near, clientSignals: signals }).blur_then_paste).toEqual({
      value: 2,
      flagged: true,
    });
    const late = [near[0]!, chat(0, back + T.blurPasteWindowMs + 1, 'c', { pasted: true })];
    expect(rowsFor({ events: late, clientSignals: signals }).blur_then_paste!.value).toBe(1);
    // A paste before returning doesn't count.
    expect(
      rowsFor({ events: [chat(0, back - 1, 'x', { pasted: true })], clientSignals: signals }).blur_then_paste!
        .value,
    ).toBe(0);
  });

  it('blur_ms sums hidden time and is never flagged on its own', () => {
    const events = [chat(1, 100_000, 'end of match marker')];
    const signals = [env(0), sig(0, 'blur', 10_000), sig(0, 'focus', 15_000), sig(0, 'blur', 90_000)];
    expect(rowsFor({ events, clientSignals: signals }).blur_ms).toEqual({
      value: 5_000 + 10_000,
      flagged: false,
    });
  });
});
