// SPEC §Consent and privacy: chat masks phone numbers, emails and links. Masking runs inside the
// engine, before a message reaches the event log, so raw contact details never enter events
// (CLAUDE.md invariant 9). Patterns are deliberately broad: a false mask costs a little chat fidelity,
// while a missed mask leaks personal data into a training set.

const EMAIL =
  /[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[A-Za-z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[A-Za-z0-9-]+)+/gi;
const URL_WITH_SCHEME = /\b(?:https?|ftp):\/\/\S+/gi;
const WWW = /\bwww\.\S+/gi;
const BARE_DOMAIN =
  /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|co|me|app|gg|xyz|info|biz|dev|ly|tv|us|uk|es|de|fr|ru|in|ai|link|club|site|online|chat)\b(?:\/\S*)?/gi;
const HANDLE_PLATFORM = /\b(?:discord\.gg|t\.me|wa\.me)\/\S+/gi;
// 7+ digits, optionally separated by spaces, dots, dashes, slashes or parentheses, optional leading +.
const PHONE = /\+?\d(?:[\s().\-/]*\d){6,}/g;

export interface MaskResult {
  text: string;
  masked: boolean;
}

export function maskChat(raw: string): MaskResult {
  let text = raw;
  text = text.replace(EMAIL, '[email]');
  text = text.replace(URL_WITH_SCHEME, '[link]');
  text = text.replace(HANDLE_PLATFORM, '[link]');
  text = text.replace(WWW, '[link]');
  text = text.replace(BARE_DOMAIN, '[link]');
  text = text.replace(PHONE, '[phone]');
  return { text, masked: text !== raw };
}
