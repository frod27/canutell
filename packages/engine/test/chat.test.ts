import { describe, expect, it } from 'vitest';
import type { ChatAction, SeatId } from '@canutell/protocol';
import { maskChat } from '../src';
import { Driver } from './helpers';

const chat = (
  seat: SeatId,
  channel: ChatAction['channel'],
  text: string,
  to: SeatId | null = null,
): ChatAction => ({
  type: 'chat',
  seat,
  channel,
  to,
  text,
  client: null,
});

describe('chat — SPEC §Deal, DECISIONS "Chat window"', () => {
  it('is open in every phase from Invest through Final ballot, closed at Reveal', () => {
    const d = new Driver();
    const seen = new Set<string>();
    while (d.phase !== 'reveal') {
      d.act(chat(0, 'table', `hello from ${d.phase}`));
      seen.add(d.phase);
      d.endPhase();
    }
    expect(seen).toEqual(new Set(['invest', 'deal', 'gamble', 'vote', 'final_ballot']));
    d.reject(chat(0, 'table', 'gg'), 'match_over');
  });

  it('table messages are visible to all; DMs only to the two participants', () => {
    const d = new Driver();
    d.act(chat(0, 'table', 'hi all'));
    d.act(chat(1, 'dm', 'psst', 2));
    expect(d.view(5).chat.messages.map((m) => m.text)).toEqual(['hi all']);
    expect(d.view(1).chat.messages.map((m) => m.text)).toEqual(['hi all', 'psst']);
    expect(d.view(2).chat.messages.map((m) => m.text)).toEqual(['hi all', 'psst']);
  });

  // CLAUDE.md invariant 4: private messages between others leave no trace in a third seat's view.
  it('a DM between two other seats, or an exile message, does not change anyone else’s view', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.exile(4, [0, 1, 2]);
    d.act(chat(0, 'table', 'before'));
    const before = JSON.stringify(d.view(5));
    d.act(chat(1, 'dm', 'secret plan', 2));
    d.act(chat(4, 'exile', 'anyone here?'));
    expect(JSON.stringify(d.view(5))).toBe(before);
    d.act(chat(0, 'table', 'after'));
    expect(d.view(5).chat.messages.map((m) => m.text)).toEqual(['before', 'after']);
    expect(JSON.stringify(d.view(5))).not.toMatch(/"index"/);
  });

  it('validates channels and recipients', () => {
    const d = new Driver();
    d.reject(chat(0, 'dm', 'x', 0), 'invalid_target');
    d.reject(chat(0, 'dm', 'x'), 'invalid_target');
    d.reject(chat(0, 'table', 'x', 1), 'invalid_target');
    d.reject(chat(0, 'exile', 'x'), 'channel_forbidden');
    d.reject(chat(0, 'table', '   '), 'empty_message');
    d.reject(chat(0, 'table', 'x'.repeat(501)), 'invalid_action');
  });

  // SPEC §Vote: an exiled player can chat only in the exile channel.
  it('exiled players chat only in the exile channel, which active players cannot see', () => {
    const d = new Driver();
    d.goTo('vote', 2);
    d.exile(5, [0, 1, 2]);
    d.reject(chat(5, 'table', 'unfair!'), 'channel_forbidden');
    d.reject(chat(5, 'dm', 'help', 0), 'channel_forbidden');
    d.reject(chat(0, 'dm', 'sorry', 5), 'invalid_target');
    d.act(chat(5, 'exile', 'I was human, I swear'));
    d.act(chat(0, 'table', 'good riddance'));
    expect(d.view(0).chat.messages.map((m) => m.text)).toEqual(['good riddance']);
    // Exiled seats keep read access to table chat.
    expect(d.view(5).chat.messages.map((m) => m.text)).toEqual(['I was human, I swear', 'good riddance']);
    expect(d.view(5).chat.channels).toEqual(['exile']);
  });

  it('masks contact details before they reach the event log (CLAUDE.md invariant 9)', () => {
    const d = new Driver();
    d.act({
      ...chat(0, 'table', 'text me at +1 (555) 123-4567 or bob@example.com'),
      client: { typingMs: 4200, pasted: true, clientSentAt: 99 },
    });
    const e = d.eventsOf('chat_message')[0]!;
    expect(e.payload.text).toBe('text me at [phone] or [email]');
    expect(e.payload.masked).toBe(true);
    expect(e.payload.client).toEqual({ typingMs: 4200, pasted: true, clientSentAt: 99 });
    expect(JSON.stringify(d.events)).not.toMatch(/555|example\.com/);
    expect(d.view(3).chat.messages[0]!.text).toBe('text me at [phone] or [email]');
  });

  it.each([
    ['join discord.gg/abc123', 'join [link]'],
    ['see https://evil.example/x?y=1 now', 'see [link] now'],
    ['www.mysite.net', '[link]'],
    ['find me on insta.com/me', 'find me on [link]'],
    ['bob (at) gmail (dot) com', '[email]'],
    ['call 0612345678', 'call [phone]'],
    ['I will invest 20 then 15', 'I will invest 20 then 15'],
    ['round 3, 5 coins, 12 back', 'round 3, 5 coins, 12 back'],
  ])('maskChat(%j) → %j', (input, expected) => {
    expect(maskChat(input).text).toBe(expected);
    expect(maskChat(input).masked).toBe(input !== expected);
  });
});
