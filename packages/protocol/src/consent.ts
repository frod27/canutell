import { CONSENT_VERSIONS, type ConsentType } from './accounts';

// The consent texts players see (SPEC §Consent and privacy). The web client renders these; docs/consent/
// holds generated copies for review (`pnpm consent:docs`, checked by a test). A change in meaning needs a
// new version: raise CONSENT_VERSIONS (and, for research, the training views in a migration).
//
// DRAFT: these texts need legal review before the closed alpha. They are written plainly, not as legal advice.

export interface ConsentText {
  type: ConsentType;
  version: number;
  title: string;
  /** Short paragraphs, each shown as its own block. */
  body: string[];
}

export const CONSENT_TEXTS: Record<ConsentType, ConsentText> = {
  terms: {
    type: 'terms',
    version: CONSENT_VERSIONS.terms,
    title: 'Terms of play',
    body: [
      'CANUTELL is a game. Some players at your table may be AI. You will be told who was who at the end of every match.',
      'Your account is a passkey on your device. We never ask for your name, email or phone number. To confirm you are 18 or older we ask for your birth month and year once, and keep only the yes or no, never the date.',
      'For your account we keep: a random player id, your passkey’s public key, and your match history (your choices, their timing, your chat with phone numbers, emails and links masked, your ballots and scores), so you can look back at your matches.',
      'Coins are game-only. They cannot be bought, sold, transferred or cashed out.',
      'Play yourself. To keep the game fair we measure automation signals: timing patterns, pasted chat, switching away from the tab, and signs of a scripted browser. A flag never bans you; it only changes how your data may be used until a person reviews it.',
      'AI players never ask for personal information. Please do not share yours.',
      'You can delete your account at any time from your account page.',
    ],
  },
  research: {
    type: 'research',
    version: CONSENT_VERSIONS.research,
    title: 'Help train CANUTELL’s AI players (optional)',
    body: [
      'If you say yes, and you have confirmed you are 18 or older, the gameplay from your matches may be used to train and evaluate CANUTELL’s own AI players: your decisions, their timing, your masked chat and your ballots.',
      'This is used only inside CANUTELL. It is never sold, and AI players trained on it are never deployed outside CANUTELL.',
      'Your passkey and anything about your identity are never part of it. Chat from players who did not say yes is removed from training data.',
      'You can change your mind at any time on your account page. Turning this off removes you from all future training data. An AI player that was already trained cannot un-learn what it learned.',
      'Saying no changes nothing about how you play.',
    ],
  },
};

/** Markdown for docs/consent/<type>-v<version>.md. */
export function consentMarkdown(t: ConsentText): string {
  return [
    `# ${t.title} (v${t.version})`,
    '',
    '_Generated from `packages/protocol/src/consent.ts` by `pnpm consent:docs`. Draft: needs legal review before the closed alpha._',
    '',
    ...t.body.flatMap((p) => [p, '']),
  ].join('\n');
}
