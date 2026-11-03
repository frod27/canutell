import type { IncomingMessage } from 'node:http';

// Rate limits (docs/proposals/hardening.md §1). Token buckets in memory: the game server is one machine.
// Keys are client IPs or account ids. They are never logged or stored, and a bucket is dropped once it has
// refilled, so an IP is held for at most its rule's window plus a sweep interval (CLAUDE.md invariant 9).

export interface RateRule {
  /** Requests allowed in a burst, refilled evenly over `windowMs`. */
  capacity: number;
  windowMs: number;
}

export const DEFAULT_RATE_RULES = {
  /** Starting a sign-up (where invite codes are checked). */
  register: { capacity: 10, windowMs: 3_600_000 },
  /** Starting a sign-in. */
  login: { capacity: 30, windowMs: 600_000 },
  /** Other signed-in account calls (/api/me*, feedback). */
  account: { capacity: 120, windowMs: 60_000 },
  /** Studio writes per account (create, new version, retire). */
  studioWrite: { capacity: 30, windowMs: 3_600_000 },
  /** New Studio agents per account. */
  studioCreate: { capacity: 5, windowMs: 86_400_000 },
  /** Public reads: leaderboard, names, game nights, reveals. */
  publicRead: { capacity: 240, windowMs: 60_000 },
  /** New WebSocket connections. */
  socket: { capacity: 30, windowMs: 60_000 },
} satisfies Record<string, RateRule>;

export type RateRuleName = keyof typeof DEFAULT_RATE_RULES;
export type RateRules = Record<RateRuleName, RateRule>;

/** Takes one token for `key` under `rule`: 0 when allowed, else the ms until one is available. */
export type RateTake = (rule: RateRuleName, key: string) => number;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `RATE_LIMITS`: unset for the defaults, `off` to disable, or overrides such as `register=20/1h,socket=60/1m`.
 * Returns null for `off`.
 */
export function parseRateLimits(raw: string | undefined): RateRules | null {
  const rules: RateRules = { ...DEFAULT_RATE_RULES };
  const s = (raw ?? '').trim();
  if (s === 'off' || s === '0') return null;
  if (!s) return rules;
  for (const part of s.split(',')) {
    const m = /^\s*(\w+)\s*=\s*(\d+)\s*\/\s*(\d+)\s*([smhd])\s*$/.exec(part);
    if (!m || !(m[1]! in rules)) throw new Error(`RATE_LIMITS: can't read "${part}" (e.g. register=20/1h)`);
    const capacity = Number(m[2]);
    const windowMs = Number(m[3]) * UNITS[m[4]!]!;
    if (capacity < 1 || windowMs < 1) throw new Error(`RATE_LIMITS: "${part}" must be positive`);
    rules[m[1] as RateRuleName] = { capacity, windowMs };
  }
  return rules;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout | null;

  constructor(
    private readonly rules: RateRules,
    private readonly o: { now?: () => number; maxKeys?: number; sweepMs?: number } = {},
  ) {
    const every = o.sweepMs ?? 60_000;
    this.sweeper = every > 0 ? setInterval(() => this.sweep(), every) : null;
    this.sweeper?.unref();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  readonly take: RateTake = (ruleName, key) => {
    const rule = this.rules[ruleName];
    const id = `${ruleName}\u0000${key}`;
    const now = this.now();
    const rate = rule.capacity / rule.windowMs;
    const b = this.buckets.get(id);
    const tokens = b ? Math.min(rule.capacity, b.tokens + (now - b.at) * rate) : rule.capacity;
    if (tokens < 1) {
      if (b) {
        b.tokens = tokens;
        b.at = now;
      }
      return Math.max(1, Math.ceil((1 - tokens) / rate));
    }
    if (!b && this.buckets.size >= (this.o.maxKeys ?? 100_000)) this.sweep();
    this.buckets.set(id, { tokens: tokens - 1, at: now });
    return 0;
  };

  /** Drops every bucket that has refilled (it would behave exactly like a missing one). */
  sweep(): void {
    const now = this.now();
    for (const [id, b] of this.buckets) {
      const rule = this.rules[id.slice(0, id.indexOf('\u0000')) as RateRuleName];
      if (b.tokens + (now - b.at) * (rule.capacity / rule.windowMs) >= rule.capacity) this.buckets.delete(id);
    }
    // Still too many (a flood of distinct keys): drop the oldest. Limits get looser, never stricter.
    const max = this.o.maxKeys ?? 100_000;
    for (const id of this.buckets.keys()) {
      if (this.buckets.size < max) break;
      this.buckets.delete(id);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }
}

/**
 * The client's IP for rate limiting, or null for internal traffic (exempt).
 *
 * With `header` set (on Fly: `fly-client-ip`, which Fly's proxy always overwrites), public traffic carries
 * it, and a request without it came over the private network (the agent service) or from this machine
 * (in-process bots). Without `header`, the socket address is used and loopback is exempt.
 */
export function clientIp(req: IncomingMessage, header?: string): string | null {
  if (header) {
    const v = req.headers[header.toLowerCase()];
    const ip = (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
    return ip || null;
  }
  const a = req.socket.remoteAddress ?? '';
  if (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.') || a === '') return null;
  return a;
}
