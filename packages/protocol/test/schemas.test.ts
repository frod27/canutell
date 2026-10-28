import { describe, expect, it } from 'vitest';
import { ActionSchema, EventSchema, MatchConfigSchema, SeatViewSchema } from '../src';

// CLAUDE.md "zod at every boundary": clients send choices only, in a fixed shape.

describe('ActionSchema', () => {
  it.each([
    { type: 'invest', seat: 0, amount: 0 },
    { type: 'invest', seat: 5, amount: 20 },
    { type: 'stake', seat: 1, to: 2, amount: 1 },
    { type: 'stake', seat: 1, to: null, amount: 0 },
    { type: 'return', seat: 2, stakeId: 'r1s1', amount: 40 },
    { type: 'gamble', seat: 3, option: 'C' },
    { type: 'vote', seat: 4, target: null },
    { type: 'ballot', seat: 0, labels: [{ target: 1, label: 'agent', confidence: 50 }] },
    { type: 'chat', seat: 0, channel: 'table', to: null, text: 'hi', client: null },
  ])('accepts %j', (a) => {
    expect(ActionSchema.safeParse(a).success).toBe(true);
  });

  it.each([
    { type: 'invest', seat: 6, amount: 0 },
    { type: 'invest', seat: 0, amount: 21 },
    { type: 'invest', seat: 0, amount: 1.5 },
    { type: 'stake', seat: 1, to: 2, amount: 0 },
    { type: 'stake', seat: 1, to: null, amount: 5 },
    { type: 'return', seat: 2, stakeId: 'r1s1', amount: 41 },
    { type: 'gamble', seat: 3, option: 'D' },
    { type: 'ballot', seat: 0, labels: [{ target: 1, label: 'agent', confidence: 101 }] },
    { type: 'chat', seat: 0, channel: 'shout', to: null, text: 'hi', client: null },
    { type: 'chat', seat: 0, channel: 'table', to: null, text: '', client: null },
    { type: 'reveal_roles', seat: 0 },
  ])('rejects %j', (a) => {
    expect(ActionSchema.safeParse(a).success).toBe(false);
  });
});

describe('MatchConfigSchema', () => {
  const seats = [0, 1, 2, 3, 4, 5].map((seatId) => ({ seatId, isAgent: false, agentVersion: null }));
  it('requires agentVersion exactly for agents', () => {
    expect(MatchConfigSchema.safeParse({ matchId: 'm', mode: 'full', isParty: false, seats }).success).toBe(
      true,
    );
    const bad = seats.map((s, i) => (i === 0 ? { ...s, isAgent: true } : s));
    expect(
      MatchConfigSchema.safeParse({ matchId: 'm', mode: 'full', isParty: false, seats: bad }).success,
    ).toBe(false);
  });
});

describe('SeatViewSchema', () => {
  it('strips nothing it does not know about: unknown keys like isAgent are not part of the view type', () => {
    expect(Object.keys(SeatViewSchema.shape)).not.toContain('isAgent');
    expect(JSON.stringify(Object.keys(SeatViewSchema.shape))).not.toMatch(/agent/i);
  });
});

describe('EventSchema', () => {
  it('validates the envelope and payload', () => {
    const ok = {
      matchId: 'm',
      seq: 0,
      type: 'pot_remainder_burned',
      seat: null,
      serverTs: 1,
      payload: { round: 1, destroyed: 3 },
    };
    expect(EventSchema.safeParse(ok).success).toBe(true);
    expect(EventSchema.safeParse({ ...ok, payload: { round: 1, destroyed: -3 } }).success).toBe(false);
    expect(EventSchema.safeParse({ ...ok, type: 'coins_bought' }).success).toBe(false);
  });
});
