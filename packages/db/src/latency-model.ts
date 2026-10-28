import type { Sql } from './sql';

// Human response-time model for agents (CLAUDE.md invariant 14: agent timing is sampled from the human
// latency distribution for that phase).
//
// Making agents more humanlike from human behavior is a training use of that data, so the training-pool
// rule applies (CLAUDE.md invariant 10): only human seats whose player is trust >= T2 with research
// consent at export time, never dev-flagged matches (phase2/3/4), bot-filled or sped-up ones. Only
// aggregate quantiles leave the database — never per-player rows. Until Phase 5 brings accounts and
// consent, the eligible pool is empty and agents use the documented prior (DECISIONS "Agent timing").

export const LATENCY_MODEL_VERSION = 1;
/** Matches carrying any of these flags never feed the model. */
export const EXCLUDED_FLAGS = ['phase2', 'phase3', 'phase4', 'bot_fill', 'sped_up'] as const;

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

const ELIGIBLE = `
  join seats s on s.match_id = x.match_id and s.seat_id = x.seat_id
  join players p on p.player_id = s.player_id
  join matches m on m.match_id = x.match_id
  where s.kind = 'human' and not s.is_agent
    and p.trust_level >= 'T2' and p.research_opt_in
    and not (m.flags && $1::text[])`;

export async function exportLatencyModel(
  sql: Sql,
  opts: { minSamples?: number } = {},
): Promise<LatencyModel> {
  const flags = [...EXCLUDED_FLAGS];
  const rows = await sql.query<{ phase: string; kind: string; latency_ms: number }>(
    `select d.phase, x.kind, x.latency_ms
       from decision_timings x
       join decisions d on d.match_id = x.match_id and d.seq = x.seq
       ${ELIGIBLE}
        and not x.timed_out and x.prompt_sent_at is not null and x.latency_ms is not null
      order by x.latency_ms`,
    [flags],
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
       join seats s on s.match_id = x.match_id and s.seat_id = x.from_seat
       join players p on p.player_id = s.player_id
       join matches m on m.match_id = x.match_id
      where s.kind = 'human' and not s.is_agent
        and p.trust_level >= 'T2' and p.research_opt_in
        and not (m.flags && $1::text[])
        and x.typing_ms is not null and not coalesce(x.pasted, false)
      order by 1`,
    [flags],
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
