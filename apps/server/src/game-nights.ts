import type { GameNights } from '@canutell/protocol';

// Scheduled game nights for the closed alpha (DECISIONS Phase 6): fixed weekly windows in one time zone,
// so the few dozen players queue at the same time. The schedule is the same for everyone and never depends
// on who is queued (CLAUDE.md invariant 7).
//
// GAME_NIGHTS="Tue,Thu,Sun 20:00-22:00 Europe/Madrid"   (several rules separated by ";")

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface GameNightRule {
  days: ReadonlySet<number>; // 0 = Sunday
  startMin: number;
  endMin: number; // ≤ startMin means the window ends the next day
  timeZone: string;
}

export function parseGameNights(spec: string): GameNightRule[] {
  return spec
    .split(';')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rule) => {
      const m = /^([A-Za-z,]+)\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(\S+)$/.exec(rule);
      if (!m)
        throw new Error(`GAME_NIGHTS: cannot parse "${rule}" (e.g. "Tue,Thu 20:00-22:00 Europe/Madrid")`);
      const days = new Set(
        m[1]!.split(',').map((d) => {
          const i = DAYS.indexOf(d.trim().slice(0, 3).toLowerCase());
          if (i < 0) throw new Error(`GAME_NIGHTS: unknown day "${d}"`);
          return i;
        }),
      );
      const [sh, sm, eh, em] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
      if (sh > 23 || eh > 24 || sm > 59 || em > 59) throw new Error(`GAME_NIGHTS: bad time in "${rule}"`);
      const timeZone = m[6]!;
      new Intl.DateTimeFormat('en-US', { timeZone }); // throws RangeError for an unknown zone
      return { days, startMin: sh * 60 + sm, endMin: eh * 60 + em, timeZone };
    });
}

function parts(t: number, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(t));
  const get = (type: string) => f.find((p) => p.type === type)!.value;
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')),
    mi: Number(get('minute')),
    wd: DAYS.indexOf(get('weekday').toLowerCase()),
  };
}

/** Offset of `timeZone` from UTC at instant t, in ms. */
function offset(t: number, timeZone: string): number {
  const p = parts(t, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
}

/** The instant a wall-clock time in `timeZone` happens (DST-aware). */
export function zonedToUtc(y: number, mo: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  const first = guess - offset(guess, timeZone);
  const second = guess - offset(first, timeZone);
  return second;
}

/** The next `count` windows that haven't ended yet at `now` (wall-clock ms). */
export function nextGameNights(rules: readonly GameNightRule[], now: number, count = 3): GameNights | null {
  if (rules.length === 0) return null;
  const windows: { start: number; end: number }[] = [];
  for (const r of rules) {
    const seen = new Set<string>();
    for (let k = -1; k <= 15; k++) {
      const p = parts(now + k * 86_400_000, r.timeZone);
      const key = `${p.y}-${p.mo}-${p.d}`;
      if (seen.has(key) || !r.days.has(p.wd)) continue;
      seen.add(key);
      const start = zonedToUtc(p.y, p.mo, p.d, r.startMin, r.timeZone);
      const end = zonedToUtc(p.y, p.mo, p.d, r.endMin + (r.endMin <= r.startMin ? 24 * 60 : 0), r.timeZone);
      if (end > now) windows.push({ start, end });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  return { timeZone: rules[0]!.timeZone, windows: windows.slice(0, count) };
}
