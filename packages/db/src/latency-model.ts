import type { Sql } from './sql';

// Human response-time model for agents (CLAUDE.md invariant 14: agent timing is sampled from the human
// latency distribution for that phase).
//
// Making agents more humanlike from human behavior is a training use of that data, so the training-pool
// rule applies (CLAUDE.md invariant 10): only seats in the training_seats view (T2+ at match time and now,
// active research consent, no unresolved automation flag, no dev/bot-fill/sped-up match). Only aggregate
// quantiles leave the database — never per-player rows. Until the closed alpha the pool is empty and agents
// use the documented prior (DECISIONS "Agent timing").

export const LATENCY_MODEL_VERSION = 1;
/** Matches carrying any of these flags are never research-eligible (mirrors the training_seats view). */
export const EXCLUDED_FLAGS = ['phase2', 'phase3', 'phase4', 'phase5', 'bot_fill', 'sped_up'] as const;

export interface LatencyBucket {
  /** Number of eligible human samples. */
  n: number;
  /** 101 quantiles (0th..100th percentile) in ms, or [] when n = 0. */
  quantiles: number[];
}

export interface LatencyModel {
  version: number;
  generatedAt: string;
  /** Buckets with fewer samples than this should not be used (the agent falls back to its prior). */
  minSamples: number;
  /** Key: `${phase}|${kind}`, e.g. `deal|stake`, `invest|return`. */
  decisions: Record<string, LatencyBucket>;
  /** Typing speed, ms per character, from client-reported typing_ms (untrusted, a rough guide only). */
  typingMsPerChar: LatencyBucket;
}

function quantiles(sorted: number[]): number[] {
  if (sorted.length === 0) return [];
  return Array.from({ length: 101 }, (_, p) => {
    const pos = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
  });
}

export async function exportLatencyModel(
  sql: Sql,
  opts: { minSamples?: number } = {},
): Promise<LatencyModel> {
  // The training pool (CLAUDE.md invariant 10) is the training_seats view; this reads only through it.
  const rows = await sql.query<{ phase: string; kind: string; latency_ms: number }>(
    `select d.phase, d.kind, d.latency_ms
       from training_decisions d
       join decision_timings x on x.match_id = d.match_id and x.seq = d.seq
      where not d.timed_out and x.prompt_sent_at is not null and d.latency_ms is not null
      order by d.latency_ms`,
  );
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.phase}|${r.kind}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r.latency_ms);
  }
  const typing = await sql.query<{ per_char: number }>(
    `select x.typing_ms::float / greatest(length(x.text), 1) as per_char
       from messages x
       join training_seats t on t.match_id = x.match_id and t.seat_id = x.from_seat
      where x.typing_ms is not null and not coalesce(x.pasted, false)
      order by 1`,
  );
  const decisions: Record<string, LatencyBucket> = {};
  for (const [key, xs] of [...byKey.entries()].sort())
    decisions[key] = { n: xs.length, quantiles: quantiles(xs) };
  const perChar = typing.map((t) => t.per_char);
  return {
    version: LATENCY_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    minSamples: opts.minSamples ?? 200,
    decisions,
    typingMsPerChar: { n: perChar.length, quantiles: quantiles(perChar) },
  };
}
