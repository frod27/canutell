import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore, exportLatencyModel, type Sql } from '../src';
import { feed, freshDb, makeAccount, metaFor, playerIdFor, simMatch } from './helpers';

// CLAUDE.md invariants 10 and 14: agents time themselves from human data, and only from data that may be
// used for training: the training_seats view (trust >= T2, research consent, clean, not dev/bot/sped-up).

let sql: Sql;
let done: () => Promise<void>;
// Each describe gets its own database: both count every eligible match in it.
function useFreshDb() {
  beforeAll(async () => {
    ({ sql, done } = await freshDb());
  });
  afterAll(() => done());
}

/** Feed a sim match; with `consent`, its human seats are T2 accounts with research consent and a web client. */
async function playAndConsent(index: number, flags: Parameters<typeof metaFor>[2], consent: boolean) {
  const r = simMatch(index);
  if (consent)
    for (const seat of r.config.seats.filter((x) => !x.isAgent))
      await makeAccount(sql, playerIdFor(index, seat.seatId), { trust: 'T2', research: true });
  const s = new PostgresStore(sql);
  await feed(s, r, metaFor(r, index, flags, consent ? 'T2' : 'T0'), { env: consent });
  await s.drain();
  return r;
}

describe('latency model export', () => {
  useFreshDb();

  it('is empty while no player is eligible (T0 guests, dev data)', async () => {
    await playAndConsent(500, ['phase3'], false);
    const model = await exportLatencyModel(sql);
    expect(model.decisions).toEqual({});
    expect(model.typingMsPerChar).toEqual({ n: 0, quantiles: [] });
  });

  it('uses only consented T2+ human seats from non-dev, non-sped-up matches; aggregates only', async () => {
    const eligible = await playAndConsent(501, [], true);
    await playAndConsent(502, ['sped_up'], true); // consented but sped up → excluded
    await playAndConsent(503, ['phase4'], true); // dev data → excluded
    const model = await exportLatencyModel(sql, { minSamples: 5 });
    const humanDecisions = eligible.events.filter(
      (e) => e.type === 'decision' && !e.payload.timedOut && !eligible.config.seats[e.seat!]!.isAgent,
    );
    const total = Object.values(model.decisions).reduce((a, b) => a + b.n, 0);
    expect(total).toBe(humanDecisions.length);
    for (const [key, b] of Object.entries(model.decisions)) {
      expect(key).toMatch(
        /^(invest|deal|gamble|vote|final_ballot)\|(invest|stake|return|gamble|vote|ballot)$/,
      );
      expect(b.quantiles).toHaveLength(101);
      for (let i = 1; i < 101; i++) expect(b.quantiles[i]!).toBeGreaterThanOrEqual(b.quantiles[i - 1]!);
    }
    // No identifiers in the export.
    expect(JSON.stringify(model)).not.toMatch(/p_|match|seat|sim-/i);
  });
});

describe('humanlikeness H (SPEC §Agents)', () => {
  useFreshDb();

  it('compares how often agent and human seats are labeled human, in eligible matches only', async () => {
    const { humanlikeness } = await import('../src');
    // Dev-flagged matches (phase3/phase4) never count.
    let idx = 600;
    while (!simMatch(idx).config.seats.some((s) => s.isAgent)) idx++;
    await playAndConsent(idx, ['phase4'], false);
    expect(await humanlikeness(sql)).toEqual([]);
    // A non-dev match whose voters are guests: evaluation needs T2+ and research consent, so nothing counts.
    let g = idx + 1;
    while (!simMatch(g).config.seats.some((s) => s.isAgent)) g++;
    await playAndConsent(g, [], false);
    expect(await humanlikeness(sql)).toEqual([]);
    // An eligible match: non-party, unflagged, voters are consented T2 accounts.
    let j = g + 1;
    while (!simMatch(j).config.seats.some((s) => s.isAgent)) j++;
    const r = await playAndConsent(j, [], true);
    const [row] = await humanlikeness(sql);
    expect(row!.agentVersion).toBe('scripted-0');
    // Recompute from the log: the consented human voters' non-blank labels.
    const isAgent = r.config.seats.map((s) => s.isAgent);
    let aL = 0,
      aH = 0,
      hL = 0,
      hH = 0;
    for (const e of r.events) {
      if (e.type !== 'decision' || e.payload.kind !== 'ballot' || isAgent[e.seat!]) continue;
      for (const l of e.payload.chosen.labels) {
        if (isAgent[l.target]) {
          aL++;
          if (l.label === 'human') aH++;
        } else {
          hL++;
          if (l.label === 'human') hH++;
        }
      }
    }
    expect([row!.agentLabels, row!.agentLabeledHuman, row!.humanLabels, row!.humanLabeledHuman]).toEqual([
      aL,
      aH,
      hL,
      hH,
    ]);
    if (aL > 0 && hL > 0 && hH > 0) expect(row!.h).toBeCloseTo(aH / aL / (hH / hL), 10);
  });
});
