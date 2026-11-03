import { describe, expect, it } from 'vitest';
import { checkAgentName, checkStyleHint, parseStudioVersion, studioVersionLabel } from '../src';

// SPEC §Agents (Studio) and CLAUDE.md invariant 13: agents never claim to be a specific real person.
describe('Studio names and style hints', () => {
  it('accepts single-word and playful names', () => {
    for (const n of ['Marlowe', 'quiet fox', 'R2-unit', 'the_banker', 'Zoë', 'Agent 7'])
      expect(checkAgentName(n), n).toBeNull();
  });

  it('refuses names that look like a person, contact details, links and odd characters', () => {
    expect(checkAgentName('Jane Doe')).toBe('person_name');
    expect(checkAgentName('Mary-Ann Smith')).toBe('person_name');
    expect(checkAgentName('me@example')).toBe('contact');
    expect(checkAgentName('call 555 123 4567')).toBe('contact');
    expect(checkAgentName('play.gg')).toBe('contact');
    expect(checkAgentName('x')).toBe('length');
    expect(checkAgentName('a'.repeat(25))).toBe('length');
    expect(checkAgentName('<script>')).toBe('characters');
  });

  it('style hints: no links or contact details, at most 300 characters', () => {
    expect(checkStyleHint('dry humour, short sentences, suspicious of big stakes')).toBeNull();
    expect(checkStyleHint('see https://x.io')).toBe('link');
    expect(checkStyleHint('dm me at bob@mail')).toBe('contact');
    expect(checkStyleHint('a'.repeat(301))).toBe('too_long');
  });

  it('version labels round-trip', () => {
    expect(studioVersionLabel(12, 3)).toBe('studio:12:v3');
    expect(parseStudioVersion('studio:12:v3')).toEqual({ agentId: 12, n: 3 });
    expect(parseStudioVersion('baseline-1')).toBeNull();
  });
});
