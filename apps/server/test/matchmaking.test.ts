import { describe, expect, it } from 'vitest';
import { ManualClock, Matchmaker, type MatchRequest, type Party } from '../src';

function setup(weights: number[], fillBotsAfterMs: number | null = null) {
  const clock = new ManualClock();
  const matches: MatchRequest[] = [];
  const parties: { party: Party; closed?: string }[] = [];
  let r = 0;
  const mm = new Matchmaker({
    clock,
    random: { int: (n) => r++ % n },
    agentWeights: weights,
    fillBotsAfterMs,
    onMatch: (m) => matches.push(m),
    onPartyChange: (party, closed) =>
      parties.push({ party: { ...party, members: [...party.members] }, closed }),
  });
  return { clock, mm, matches, parties };
}

describe('public queue — SPEC §Match structure', () => {
  it('2 agents drawn → a match forms at 4 humans', () => {
    const t = setup([0, 0, 1]);
    for (const p of ['a', 'b', 'c']) t.mm.join(p, 'full');
    expect(t.matches).toEqual([]);
    t.mm.join('d', 'full');
    expect(t.matches).toEqual([
      { mode: 'full', humans: ['a', 'b', 'c', 'd'], agents: 2, fillers: 0, isParty: false },
    ]);
  });

  it('0 agents drawn → needs 6 humans', () => {
    const t = setup([1, 0, 0]);
    for (const p of ['a', 'b', 'c', 'd', 'e']) t.mm.join(p, 'quick');
    expect(t.matches).toEqual([]);
    t.mm.join('f', 'quick');
    expect(t.matches[0]).toMatchObject({ humans: ['a', 'b', 'c', 'd', 'e', 'f'], agents: 0 });
  });

  it('modes queue separately; leaving removes the player', () => {
    const t = setup([0, 0, 1]);
    for (const p of ['a', 'b', 'c']) t.mm.join(p, 'full');
    t.mm.join('x', 'quick');
    t.mm.leave('c');
    t.mm.join('d', 'full');
    expect(t.matches).toEqual([]);
    t.mm.join('e', 'full');
    expect(t.matches[0]!.humans).toEqual(['a', 'b', 'd', 'e']);
    expect(t.mm.queuedMode('x')).toBe('quick');
  });

  it('dev fill seats bots in human seats after the timeout, flagged as fillers', () => {
    const t = setup([0, 1, 0], 5_000);
    t.mm.join('a', 'full');
    t.clock.advance(4_999);
    expect(t.matches).toEqual([]);
    t.clock.advance(1);
    expect(t.matches[0]).toEqual({ mode: 'full', humans: ['a'], agents: 1, fillers: 4, isParty: false });
  });
});

describe('parties — SPEC §Integrity (party queues tagged), CLAUDE.md invariant 11', () => {
  it('4–6 humans plus agents in the remaining seats; tagged isParty', () => {
    const t = setup([1, 1, 1]);
    const party = t.mm.createParty('host', 'quick');
    expect(t.mm.startParty('host')).toMatch(/at least 4/);
    for (const p of ['b', 'c', 'd']) t.mm.joinParty(p, party.code);
    expect(t.mm.startParty('b')).toBe('only the host can start');
    expect(t.mm.startParty('host')).toBeNull();
    expect(t.matches[0]).toEqual({
      mode: 'quick',
      humans: ['host', 'b', 'c', 'd'],
      agents: 2,
      fillers: 0,
      isParty: true,
    });
  });

  it('a full party of 6 has no agents; a 7th cannot join', () => {
    const t = setup([1, 1, 1]);
    const { code } = t.mm.createParty('h', 'full');
    for (const p of ['b', 'c', 'd', 'e', 'f']) t.mm.joinParty(p, code);
    expect(t.mm.joinParty('g', code)).toBe('party is full');
    t.mm.startParty('h');
    expect(t.matches[0]).toMatchObject({ agents: 0, fillers: 0, isParty: true });
  });

  it('the host leaving closes the party; members are told', () => {
    const t = setup([1, 1, 1]);
    const { code } = t.mm.createParty('h', 'full');
    t.mm.joinParty('b', code);
    t.mm.leaveParty('h');
    expect(t.parties.at(-1)!.closed).toBe('host left');
    expect(t.mm.partyCode('b')).toBeNull();
    expect(t.mm.joinParty('c', code)).toBe('no such party');
  });

  it('joining a party removes the player from the public queue', () => {
    const t = setup([1, 1, 1]);
    t.mm.join('b', 'full');
    const { code } = t.mm.createParty('h', 'full');
    t.mm.joinParty('b', code);
    expect(t.mm.queuedMode('b')).toBeNull();
  });

  it('party codes use an unambiguous alphabet', () => {
    const t = setup([1, 1, 1]);
    const { code } = t.mm.createParty('h', 'full');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});
