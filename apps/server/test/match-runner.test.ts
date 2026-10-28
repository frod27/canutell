import { describe, expect, it } from 'vitest';
import { hashJson, replay } from '@canutell/engine';
import { PHASE_DURATION_MS, type ServerMessage, type SeatId } from '@canutell/protocol';
import { ManualClock, MatchRunner, MemoryStore, type MatchMeta } from '../src';

function meta(agents: SeatId[] = []): MatchMeta {
  return {
    matchId: 'm1',
    mode: 'quick',
    seed: 'seed-1',
    isParty: false,
    config: {
      matchId: 'm1',
      mode: 'quick',
      isParty: false,
      seats: [0, 1, 2, 3, 4, 5].map((seatId) => ({
        seatId,
        isAgent: agents.includes(seatId as SeatId),
        agentVersion: agents.includes(seatId as SeatId) ? 'scripted-0' : null,
      })),
    },
    occupants: [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, kind: 'human' as const, playerId: `p${seat}` })),
    flags: ['phase2'],
    createdAt: 0,
    clockSpeed: 1,
    status: 'running',
    endedAt: null,
  };
}

function setup(agents: SeatId[] = []) {
  const clock = new ManualClock();
  const store = new MemoryStore();
  const ended: string[] = [];
  const runner = new MatchRunner(meta(agents), { clock, store, onEnd: (_r, s) => ended.push(s) });
  const inbox: ServerMessage[][] = [0, 1, 2, 3, 4, 5].map(() => []);
  const connected = [true, true, true, true, true, true];
  runner.start();
  const attach = (seat: SeatId) => {
    connected[seat] = true;
    runner.attach(seat, {
      send: (m) => {
        if (!connected[seat]) return false;
        inbox[seat]!.push(m);
        return true;
      },
    });
  };
  for (const s of [0, 1, 2, 3, 4, 5] as SeatId[]) attach(s);
  const views = (seat: SeatId) =>
    inbox[seat]!.filter((m): m is Extract<ServerMessage, { type: 'view' }> => m.type === 'view');
  const act = (seat: SeatId, action: Parameters<MatchRunner['handleAction']>[1]['action'], id = 'x') =>
    runner.handleAction(seat, {
      type: 'action',
      matchId: 'm1',
      clientActionId: id,
      action,
      seenPhase: null,
      clientSentAt: 42,
    });
  const stored = () => store.matches.get('m1')!;
  return { clock, store, runner, inbox, views, act, attach, connected, stored, ended };
}

describe('MatchRunner — server-authoritative loop (CLAUDE.md invariant 5)', () => {
  it('runs a whole match on server deadlines and logs a replayable record', () => {
    const t = setup();
    expect(t.views(0).at(-1)!.view.phase).toBe('invest');
    t.act(0, { type: 'invest', seat: 0, amount: 7 });
    while (t.clock.next()) {
      /* advance through every deadline */
    }
    expect(t.runner.isOver).toBe(true);
    expect(t.ended).toEqual(['completed']);
    const m = t.stored();
    expect(m.meta.status).toBe('completed');
    const r = replay(m.meta.config, m.meta.seed, m.inputs);
    expect(hashJson(r.events)).toBe(hashJson(m.events));
    expect(t.views(3).at(-1)!.view.reveal).not.toBeNull();
  });

  it('acks valid actions and rejects invalid, spoofed, foreign-match and late ones — and logs rejections', () => {
    const t = setup();
    t.act(0, { type: 'invest', seat: 0, amount: 5 }, 'ok');
    expect(t.inbox[0]!.some((m) => m.type === 'action.ack' && m.clientActionId === 'ok')).toBe(true);
    t.act(0, { type: 'invest', seat: 1, amount: 5 }, 'spoof');
    t.runner.handleAction(0, {
      type: 'action',
      matchId: 'other',
      clientActionId: 'foreign',
      action: { type: 'invest', seat: 0, amount: 1 },
      seenPhase: null,
      clientSentAt: null,
    });
    t.act(2, { type: 'gamble', seat: 2, option: 'A' }, 'phase');
    t.clock.jump(PHASE_DURATION_MS.invest); // the deadline timer is late; the action is still late
    t.act(3, { type: 'invest', seat: 3, amount: 5 }, 'late');
    const rejected = (seat: number) =>
      t.inbox[seat]!.filter(
        (m): m is Extract<ServerMessage, { type: 'action.rejected' }> => m.type === 'action.rejected',
      );
    expect(rejected(0).map((m) => [m.clientActionId, m.code])).toEqual([
      ['spoof', 'not_your_seat'],
      ['foreign', 'wrong_match'],
    ]);
    expect(rejected(2).map((m) => m.code)).toEqual(['wrong_phase']);
    expect(rejected(3).map((m) => m.code)).toEqual(['late']);
    expect(t.stored().rejections.map((r) => r.code)).toEqual([
      'not_your_seat',
      'wrong_match',
      'wrong_phase',
      'late',
    ]);
  });

  // DECISIONS "Late actions": acting on a phase that has already ended is reported as late.
  it('an action based on an ended phase is rejected as late, with the engine reason kept', () => {
    const t = setup();
    t.clock.next(); // Invest → Deal
    t.runner.handleAction(2, {
      type: 'action',
      matchId: 'm1',
      clientActionId: 'slow',
      action: { type: 'invest', seat: 2, amount: 5 },
      seenPhase: { round: 1, phase: 'invest' },
      clientSentAt: null,
    });
    const r = t.inbox[2]!.find((m) => m.type === 'action.rejected');
    expect(r).toMatchObject({ code: 'late' });
    expect(t.stored().rejections.at(-1)).toMatchObject({ code: 'late', engineCode: 'wrong_phase' });
    // Without seenPhase, the engine's own code is reported.
    t.act(2, { type: 'invest', seat: 2, amount: 5 }, 'blind');
    expect(t.stored().rejections.at(-1)).toMatchObject({ code: 'wrong_phase', engineCode: 'wrong_phase' });
  });

  it('measures latency on the server from prompt delivery to arrival (CLAUDE.md invariant 6)', () => {
    const t = setup();
    t.clock.advance(4_321);
    t.act(1, { type: 'invest', seat: 1, amount: 3 });
    const timing = t.stored().timings.find((r) => r.seat === 1 && r.kind === 'invest')!;
    expect(timing.latencyMs).toBe(4_321);
    expect(timing.timedOut).toBe(false);
    expect(timing.clientSentAt).toBe(42); // stored, not trusted
    t.clock.next(); // end Invest: the other five time out
    const timeouts = t.stored().timings.filter((r) => r.kind === 'invest' && r.timedOut);
    expect(timeouts).toHaveLength(5);
    for (const r of timeouts) expect(r).toMatchObject({ latencyMs: null, receivedAt: null });
    expect(timeouts.every((r) => r.promptSentAt !== null)).toBe(true);
  });

  it('a seat that was disconnected never saw the prompt: promptSentAt null; on reconnect the clock starts then', () => {
    const t = setup();
    t.connected[4] = false;
    t.runner.detach(4);
    t.clock.next(); // Invest ends; Deal opens while seat 4 is away
    t.clock.advance(10_000);
    t.attach(4); // reconnect 10 s into Deal
    t.clock.advance(2_000);
    t.act(4, { type: 'stake', seat: 4, to: null, amount: 0 });
    const stake = t.stored().timings.find((r) => r.seat === 4 && r.kind === 'stake')!;
    expect(stake.latencyMs).toBe(2_000);
    const invest = t.stored().timings.find((r) => r.seat === 4 && r.kind === 'invest')!;
    expect(invest).toMatchObject({ timedOut: true, promptSentAt: expect.any(Number) });
    expect(t.stored().connections.map((c) => [c.seat, c.state])).toContainEqual([4, 'disconnected']);
  });

  it('logs prompt never shown as promptSentAt = null', () => {
    const t = setup();
    t.clock.next(); // into Deal
    t.connected[5] = false;
    t.runner.detach(5);
    t.clock.next(); // Deal ends → Gamble opens while seat 5 is away
    t.clock.next(); // Gamble ends with seat 5 timing out on a prompt it never saw
    const gamble = t.stored().timings.find((r) => r.seat === 5 && r.kind === 'gamble')!;
    expect(gamble).toMatchObject({ timedOut: true, promptSentAt: null });
  });

  // DECISIONS "View pushes": no frame reveals that someone else acted privately.
  it('pushes a view to a seat only when that seat’s own view changed', () => {
    const t = setup();
    t.clock.next(); // Deal
    const before = t.inbox.map((b) => b.length);
    t.act(0, { type: 'stake', seat: 0, to: 1, amount: 5 });
    const after = t.inbox.map((b) => b.length);
    expect(after[2]! - before[2]!).toBe(0);
    expect(after[5]! - before[5]!).toBe(0);
    expect(after[1]! - before[1]!).toBe(1); // receiver's view changed
    expect(after[0]! - before[0]!).toBe(2); // sender: ack + new view
    t.act(3, { type: 'chat', seat: 3, channel: 'table', to: null, text: 'hi', client: null });
    for (const s of [0, 1, 2, 4, 5])
      expect(
        t
          .views(s as SeatId)
          .at(-1)!
          .view.chat.messages.at(-1)!.text,
      ).toBe('hi');
  });

  it('never sends roles before Reveal, in any frame to any seat', () => {
    const t = setup([1, 4]);
    while (!t.runner.isOver) {
      for (const s of [0, 1, 2, 3, 4, 5] as SeatId[]) {
        for (const m of t.inbox[s]!) {
          if (m.type === 'view' && m.view.phase === 'reveal') continue;
          expect(JSON.stringify(m)).not.toMatch(/isAgent|agentVersion|scripted-0/);
        }
      }
      t.clock.next();
    }
  });

  it('view versions increase and each view is the recipient’s own seat', () => {
    const t = setup();
    t.clock.next();
    t.clock.next();
    for (const s of [0, 1, 2, 3, 4, 5] as SeatId[]) {
      const vs = t.views(s);
      vs.forEach((v, i) => {
        expect(v.view.seat).toBe(s);
        if (i > 0) expect(v.viewVersion).toBeGreaterThan(vs[i - 1]!.viewVersion);
      });
    }
  });
});
