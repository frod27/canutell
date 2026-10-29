import type { MatchEvent, SeatId, TrustLevel } from '@canutell/protocol';
import type { ClientSignalRecord, TimingRecord } from './types';

// SPEC §Integrity: automation signals per seat, derived from the log at match end. Pure: the same log
// always gives the same rows, so integrity_signals is rebuilt like every other derived table.
//
// Which seats: account holders' human seats and every bot/agent seat. Guest (T0) seats and deleted
// accounts get nothing (DECISIONS "Guests and deleted accounts"). Bot and agent rows never touch anyone's
// trust; they show what the detectors make of scripted clients.
//
// The thresholds are starting values (docs/proposals/phase-5.md §4), to be tuned against real players in
// the closed alpha. A flag lowers trust by one level until a person reviews it; it never bans.

export const INTEGRITY_THRESHOLDS = {
  /** latency_cv: flag below this coefficient of variation… */
  latencyCv: 0.15,
  /** …but only with at least this many measured decisions. */
  latencyMinDecisions: 8,
  /** fast_replies: reading speed, ms per word of the message being answered. */
  readMsPerWord: 240,
  /** fast_replies: fastest plausible typing, chars per second. */
  typeCharsPerSec: 15,
  fastReplies: 3,
  pastes: 3,
  /** blur_then_paste: a paste within this long after returning to the tab. */
  blurPasteWindowMs: 30_000,
  blurThenPaste: 2,
} as const;

export const INTEGRITY_SIGNALS = [
  'latency_cv',
  'fast_replies',
  'pastes',
  'blur_then_paste',
  'blur_ms',
  'headless',
  'no_client_signals',
] as const;
export type IntegritySignal = (typeof INTEGRITY_SIGNALS)[number];

export interface IntegrityRow {
  seat_id: SeatId;
  signal: IntegritySignal;
  value: number;
  flagged: boolean;
}

export interface IntegritySeat {
  seat: SeatId;
  kind: 'human' | 'agent' | 'filler';
  /** Humans: trust at match time; T0 means a guest. */
  trustLevel: TrustLevel | null;
  /** A deleted account's seats are treated like a guest's. */
  deleted?: boolean;
}

type Chat = Extract<MatchEvent, { type: 'chat_message' }>;
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function integrityApplies(s: IntegritySeat): boolean {
  if (s.kind !== 'human') return true;
  return !s.deleted && s.trustLevel !== null && s.trustLevel !== 'T0';
}

export function deriveIntegrity(input: {
  seats: readonly IntegritySeat[];
  events: readonly MatchEvent[];
  timings: readonly TimingRecord[];
  clientSignals: readonly ClientSignalRecord[];
}): IntegrityRow[] {
  const T = INTEGRITY_THRESHOLDS;
  const chats = input.events.filter((e): e is Chat => e.type === 'chat_message');
  const end = input.events.length > 0 ? input.events[input.events.length - 1]!.serverTs : 0;
  const rows: IntegrityRow[] = [];
  for (const s of [...input.seats].sort((a, b) => a.seat - b.seat)) {
    if (!integrityApplies(s)) continue;
    const seat = s.seat;
    const push = (signal: IntegritySignal, value: number, flagged: boolean) =>
      rows.push({ seat_id: seat, signal, value, flagged });

    // Input timing variance: server-measured latencies only (CLAUDE.md invariant 6).
    const lat = input.timings
      .filter((t) => t.seat === seat && !t.timedOut && t.latencyMs !== null)
      .map((t) => t.latencyMs!);
    if (lat.length >= 2) {
      const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
      const sd = Math.sqrt(lat.reduce((a, b) => a + (b - mean) ** 2, 0) / lat.length);
      const cv = mean > 0 ? sd / mean : 0;
      push('latency_cv', cv, lat.length >= T.latencyMinDecisions && cv < T.latencyCv);
    }

    // Replies faster than reading the message and typing the reply. Only an unanswered message counts:
    // if the seat spoke after it, the next line is not a reply to it.
    let fast = 0;
    let lastVisible: Chat | null = null;
    let lastOwnTs = -Infinity;
    for (const c of chats) {
      if (c.seat === seat) {
        if (lastVisible && lastVisible.serverTs > lastOwnTs) {
          const needed =
            words(lastVisible.payload.text) * T.readMsPerWord +
            (c.payload.text.length * 1000) / T.typeCharsPerSec;
          if (c.serverTs - lastVisible.serverTs < needed) fast++;
        }
        lastOwnTs = c.serverTs;
      } else if (c.payload.channel !== 'dm' || c.payload.to === seat) {
        lastVisible = c;
      }
    }
    push('fast_replies', fast, fast >= T.fastReplies);

    const own = input.clientSignals.filter((x) => x.seat === seat).sort((a, b) => a.at - b.at);
    const pasted = chats.filter((c) => c.seat === seat && c.payload.client?.pasted === true);
    push('pastes', pasted.length, pasted.length >= T.pastes);

    const focusAt = own.filter((x) => x.kind === 'focus').map((x) => x.at);
    const afterBlur = pasted.filter((c) =>
      focusAt.some((f) => f <= c.serverTs && c.serverTs - f <= T.blurPasteWindowMs),
    ).length;
    push('blur_then_paste', afterBlur, afterBlur >= T.blurThenPaste);

    let hiddenMs = 0;
    let hiddenSince: number | null = null;
    for (const x of own) {
      if (x.kind === 'blur' && hiddenSince === null) hiddenSince = x.at;
      else if (x.kind === 'focus' && hiddenSince !== null) {
        hiddenMs += x.at - hiddenSince;
        hiddenSince = null;
      }
    }
    if (hiddenSince !== null) hiddenMs += Math.max(0, end - hiddenSince);
    push('blur_ms', hiddenMs, false);

    const envs = own.filter((x) => x.kind === 'env' && x.value !== null).map((x) => x.value!);
    const headless = envs.some(
      (v) => v.webdriver || v.headlessUserAgent || v.noLanguages || v.zeroOuterSize || v.serverHeadlessUa,
    );
    push('headless', headless ? 1 : 0, headless);
    push('no_client_signals', envs.length === 0 ? 1 : 0, envs.length === 0);
  }
  return rows;
}
