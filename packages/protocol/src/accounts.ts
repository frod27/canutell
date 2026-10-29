import { z } from 'zod';

// Accounts, trust levels and consent (SPEC §Integrity, §Consent and privacy; DECISIONS Phase 5).
// A player only ever sees their OWN account summary. Nothing here is ever sent about another seat: agents
// have no accounts, so any account status on a seat would give them away (CLAUDE.md invariant 7).

export const TrustLevelSchema = z.enum(['T0', 'T1', 'T2', 'T3']);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export const TRUST_ORDER: readonly TrustLevel[] = ['T0', 'T1', 'T2', 'T3'];
export const trustAtLeast = (level: TrustLevel, min: TrustLevel): boolean =>
  TRUST_ORDER.indexOf(level) >= TRUST_ORDER.indexOf(min);

/**
 * Required consent text versions (docs/consent/). Raising one is a migration (the training views check the
 * research version) and players are asked again.
 */
export const CONSENT_VERSIONS = { terms: 1, research: 1 } as const;
export type ConsentType = keyof typeof CONSENT_VERSIONS;

/** Session tokens: `s_` + 64 hex characters (256 bits). Only their SHA-256 is stored. */
export const SESSION_TOKEN_PATTERN = /^s_[0-9a-f]{64}$/;

export const AccountSummarySchema = z.object({
  playerId: z.string(),
  trustLevel: TrustLevelSchema,
  /** null: not answered yet; false: under 18 (stays T1, play only). */
  ageConfirmed: z.boolean().nullable(),
  /** Active research consent at the current required version. */
  researchConsent: z.boolean(),
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/**
 * Sent once per connection by the web client: headless-browser indicators reduced to booleans. No raw
 * fingerprint, no user-agent string, nothing that could follow a person (SPEC §Integrity).
 */
export const ClientEnvSchema = z.object({
  webdriver: z.boolean(),
  headlessUserAgent: z.boolean(),
  noLanguages: z.boolean(),
  zeroOuterSize: z.boolean(),
});
export type ClientEnv = z.infer<typeof ClientEnvSchema>;

// ---------- HTTP: passkey sign-up and sign-in (WebAuthn) ----------

/** A WebAuthn credential response as produced by @simplewebauthn/browser; verified by the server library. */
export const WebAuthnResponseSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().max(16_384) }),
  clientExtensionResults: z.looseObject({}),
});

export const RegisterOptionsRequestSchema = z.object({
  /** The terms version the player accepted on the first sign-up screen. */
  termsVersion: z.literal(CONSENT_VERSIONS.terms),
  /** Closed alpha: the invite code (required when the server has INVITES_REQUIRED). */
  invite: z.string().min(1).max(32).optional(),
});
/** `options` is PublicKeyCredentialCreationOptionsJSON, passed straight to the browser library. */
export const CeremonyOptionsResponseSchema = z.object({
  flowId: z.string(),
  options: z.looseObject({ challenge: z.string() }),
});
export const CeremonyVerifyRequestSchema = z.object({
  flowId: z.string().min(16).max(128),
  response: WebAuthnResponseSchema,
});
export const SessionResponseSchema = z.object({
  session: z.string().regex(SESSION_TOKEN_PATTERN),
  account: AccountSummarySchema,
});

// ---------- HTTP: the signed-in player's own account (Authorization: Bearer <session>) ----------

export const AgeRequestSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12),
});
export const ResearchConsentRequestSchema = z.object({
  granted: z.boolean(),
  version: z.literal(CONSENT_VERSIONS.research),
});
export const PasskeyListResponseSchema = z.object({
  passkeys: z.array(
    z.object({
      id: z.string(),
      createdAt: z.number(),
      lastUsedAt: z.number().nullable(),
      multiDevice: z.boolean(),
      backedUp: z.boolean(),
    }),
  ),
});
export type PasskeyListResponse = z.infer<typeof PasskeyListResponseSchema>;
