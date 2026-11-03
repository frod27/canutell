// Operator alerts (docs/proposals/hardening.md §3). One webhook, ALERT_WEBHOOK_URL: the body carries both
// `text` (Slack) and `content` (Discord). Fire-and-forget with a timeout; never blocks a match.
//
// Alerts carry codes, counts, match ids and agent labels only: never player ids, IPs, chat or stack traces
// (the full error stays in the server log). As a backstop, anything shaped like a player id or an IP is
// masked before sending.

export type AlertKey =
  'db_write' | 'match_aborted' | 'agent_fallback' | 'studio_paused' | 'http_500' | 'server_started';

/** Raises an alert. The same key fires at most once per throttle window. */
export type Alert = (key: AlertKey, text: string) => void;

export interface AlertsOptions {
  webhookUrl?: string;
  /** Prefixed to every message, e.g. the app name. */
  source?: string;
  log?: (msg: string) => void;
  throttleMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export function scrubAlert(text: string): string {
  return text
    .replace(/\b[pb]_[0-9a-f-]{8,}\b/gi, '[player]')
    .replace(/\bs_[0-9a-f]{16,}\b/gi, '[session]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]')
    .slice(0, 1500);
}

export class Alerts {
  private readonly last = new Map<
    AlertKey,
    { at: number; suppressed: number; flush: NodeJS.Timeout | null }
  >();
  private readonly throttleMs: number;

  constructor(private readonly o: AlertsOptions = {}) {
    this.throttleMs = o.throttleMs ?? 600_000;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  readonly alert: Alert = (key, text) => {
    const now = this.now();
    const s = this.last.get(key);
    if (s && now - s.at < this.throttleMs) {
      s.suppressed++;
      // Report the suppressed ones when the window closes, even if nothing else happens.
      if (!s.flush) {
        s.flush = setTimeout(
          () => {
            s.flush = null;
            const n = s.suppressed;
            if (n === 0) return;
            s.suppressed = 0;
            s.at = this.now();
            this.emit(key, `${n} more alert(s) of this kind since the last one`);
          },
          this.throttleMs - (now - s.at),
        );
        s.flush.unref?.();
      }
      return;
    }
    if (s?.flush) clearTimeout(s.flush);
    const extra = s?.suppressed ? ` (+${s.suppressed} similar since the last alert)` : '';
    this.last.set(key, { at: now, suppressed: 0, flush: null });
    this.emit(key, text + extra);
  };

  private emit(key: AlertKey, text: string): void {
    const body = scrubAlert(`${this.o.source ?? 'CANUTELL'} [${key}] ${text}`);
    this.o.log?.(`ALERT ${body}`);
    if (this.o.webhookUrl) void this.post(body);
  }

  private async post(text: string): Promise<void> {
    const f = this.o.fetch ?? fetch;
    try {
      const r = await f(this.o.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 5_000),
      });
      if (!r.ok) this.o.log?.(`alert webhook answered ${r.status}`);
    } catch (e) {
      this.o.log?.(`alert webhook failed: ${String(e)}`);
    }
  }

  close(): void {
    for (const s of this.last.values()) if (s.flush) clearTimeout(s.flush);
  }
}
