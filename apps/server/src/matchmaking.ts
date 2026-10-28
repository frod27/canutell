import { MAX_AGENTS, PARTY_CODE_LENGTH, SEAT_COUNT, type Mode } from '@canutell/protocol';
import type { Clock, TimerHandle } from './clock';

// SPEC §Match structure: 6 seats, 0–2 agents with configurable odds. The agent count for the next
// public match is drawn *before* humans gather, and the queue reports no counts, so nothing a player
// sees in the lobby reveals how many agents they will face (CLAUDE.md invariant 7).

export interface MatchRequest {
  mode: Mode;
  /** Human players, in no particular order (seats are shuffled later). */
  humans: string[];
  agents: number;
  /** Bots sitting in human seats (dev fill only). */
  fillers: number;
  isParty: boolean;
}

export interface Random {
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

export interface MatchmakerOptions {
  clock: Clock;
  random: Random;
  /** Relative weights for 0, 1, 2 agents. */
  agentWeights: readonly number[];
  /** Dev only: fill a waiting queue/party with bots after this long (server ms). null = never. */
  fillBotsAfterMs: number | null;
  onMatch(request: MatchRequest): void;
  onPartyChange(party: Party, closedReason?: string): void;
}

export interface Party {
  code: string;
  mode: Mode;
  host: string;
  members: string[];
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export class Matchmaker {
  private readonly queues: Record<Mode, { waiting: string[]; agents: number; fillTimer: TimerHandle | null }>;
  private readonly parties = new Map<string, Party>();
  private readonly partyOf = new Map<string, string>();
  private readonly queuedIn = new Map<string, Mode>();

  constructor(private readonly o: MatchmakerOptions) {
    this.queues = {
      full: { waiting: [], agents: this.drawAgents(), fillTimer: null },
      quick: { waiting: [], agents: this.drawAgents(), fillTimer: null },
    };
  }

  private drawAgents(): number {
    const w = this.o.agentWeights;
    const total = w.reduce((a, b) => a + b, 0);
    let roll = this.o.random.int(total);
    for (let k = 0; k <= MAX_AGENTS; k++) {
      if (roll < w[k]!) return k;
      roll -= w[k]!;
    }
    return 0;
  }

  queuedMode(playerId: string): Mode | null {
    return this.queuedIn.get(playerId) ?? null;
  }

  partyCode(playerId: string): string | null {
    return this.partyOf.get(playerId) ?? null;
  }

  // ---------- public queue ----------

  join(playerId: string, mode: Mode): void {
    this.leave(playerId);
    this.queuedIn.set(playerId, mode);
    const q = this.queues[mode];
    q.waiting.push(playerId);
    this.tryForm(mode);
    this.armFill(mode);
  }

  leave(playerId: string): void {
    const mode = this.queuedIn.get(playerId);
    if (!mode) return;
    this.queuedIn.delete(playerId);
    const q = this.queues[mode];
    q.waiting = q.waiting.filter((p) => p !== playerId);
    if (q.waiting.length === 0 && q.fillTimer) {
      this.o.clock.clearTimer(q.fillTimer);
      q.fillTimer = null;
    }
  }

  private tryForm(mode: Mode): void {
    const q = this.queues[mode];
    while (q.waiting.length >= SEAT_COUNT - q.agents) {
      const humans = q.waiting.splice(0, SEAT_COUNT - q.agents);
      for (const h of humans) this.queuedIn.delete(h);
      const agents = q.agents;
      q.agents = this.drawAgents();
      this.o.onMatch({ mode, humans, agents, fillers: 0, isParty: false });
    }
  }

  private armFill(mode: Mode): void {
    const q = this.queues[mode];
    if (this.o.fillBotsAfterMs === null || q.fillTimer || q.waiting.length === 0) return;
    q.fillTimer = this.o.clock.setTimer(this.o.clock.now() + this.o.fillBotsAfterMs, () => {
      q.fillTimer = null;
      if (q.waiting.length === 0) return;
      const humans = q.waiting.splice(0, SEAT_COUNT - q.agents);
      for (const h of humans) this.queuedIn.delete(h);
      const agents = q.agents;
      q.agents = this.drawAgents();
      this.o.onMatch({ mode, humans, agents, fillers: SEAT_COUNT - agents - humans.length, isParty: false });
      this.armFill(mode);
    });
  }

  // ---------- parties (is_party = true, CLAUDE.md invariant 11) ----------

  createParty(host: string, mode: Mode): Party {
    this.leave(host);
    this.leaveParty(host);
    let code = '';
    do {
      code = Array.from(
        { length: PARTY_CODE_LENGTH },
        () => CODE_ALPHABET[this.o.random.int(CODE_ALPHABET.length)],
      ).join('');
    } while (this.parties.has(code));
    const party: Party = { code, mode, host, members: [host] };
    this.parties.set(code, party);
    this.partyOf.set(host, code);
    this.o.onPartyChange(party);
    return party;
  }

  joinParty(playerId: string, code: string): Party | string {
    const party = this.parties.get(code);
    if (!party) return 'no such party';
    if (party.members.includes(playerId)) return party;
    if (party.members.length >= SEAT_COUNT) return 'party is full';
    this.leave(playerId);
    this.leaveParty(playerId);
    party.members.push(playerId);
    this.partyOf.set(playerId, code);
    this.o.onPartyChange(party);
    return party;
  }

  leaveParty(playerId: string): void {
    const code = this.partyOf.get(playerId);
    if (!code) return;
    const party = this.parties.get(code)!;
    this.partyOf.delete(playerId);
    if (party.host === playerId) {
      this.closeParty(party, 'host left');
      return;
    }
    party.members = party.members.filter((m) => m !== playerId);
    this.o.onPartyChange(party);
  }

  /** Humans needed for a party to start without dev fill. */
  static readonly MIN_PARTY = SEAT_COUNT - MAX_AGENTS;

  canStart(party: Party): boolean {
    return party.members.length >= Matchmaker.MIN_PARTY || this.o.fillBotsAfterMs !== null;
  }

  /**
   * A party plays as its members plus agents in the remaining seats (DECISIONS "Parties"): 4–6 humans,
   * so 0–2 agents. The party can work out the agent count, which is why party matches are tagged
   * and excluded from detection metrics (SPEC §Integrity, CLAUDE.md invariant 11).
   */
  startParty(playerId: string): string | null {
    const code = this.partyOf.get(playerId);
    const party = code ? this.parties.get(code) : undefined;
    if (!party) return 'not in a party';
    if (party.host !== playerId) return 'only the host can start';
    if (!this.canStart(party)) return `a party needs at least ${Matchmaker.MIN_PARTY} players`;
    const humans = [...party.members];
    const agents = Math.min(MAX_AGENTS, SEAT_COUNT - humans.length);
    const fillers = SEAT_COUNT - humans.length - agents;
    this.closeParty(party, 'started');
    this.o.onMatch({ mode: party.mode, humans, agents, fillers, isParty: true });
    return null;
  }

  private closeParty(party: Party, reason: string): void {
    this.parties.delete(party.code);
    for (const m of party.members) this.partyOf.delete(m);
    this.o.onPartyChange(party, reason);
  }
}
