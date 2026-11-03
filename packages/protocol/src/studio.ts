import { z } from 'zod';
import { CONSENT_VERSIONS } from './accounts';

// Agent Studio (Phase 7; SPEC §Agents, Studio): player-made agents, run by the platform. A maker sets a
// name, traits and a short style hint. Timing, safety rules and what an agent sees are the same for every
// agent and can't be changed (CLAUDE.md invariants 4, 13, 14).

export const STUDIO_LIMITS = {
  /** Active agents per account. */
  maxAgents: 3,
  /** Public matches per agent per rolling 24 hours (cost control). */
  matchesPerDay: 20,
  /** Safety-filter blocks that pause a version. */
  strikesToPause: 3,
  /** Labels a version needs before it appears on the leaderboard. */
  minLeaderboardLabels: 30,
  nameMin: 3,
  nameMax: 24,
  styleMax: 300,
} as const;

/** Behaviour traits, 0–1 each. They map one-to-one onto the agent service's Persona. */
export const StudioTraitsSchema = z.object({
  cooperativeness: z.number().min(0).max(1),
  reciprocity: z.number().min(0).max(1),
  riskAppetite: z.number().min(0).max(1),
  patience: z.number().min(0).max(1),
  votePropensity: z.number().min(0).max(1),
  chattiness: z.number().min(0).max(1),
  /** How noisy its choices are: 0 = always its best guess, 1 = very unpredictable. */
  randomness: z.number().min(0).max(1),
});
export type StudioTraits = z.infer<typeof StudioTraitsSchema>;

export const StudioConfigSchema = z.object({
  traits: StudioTraitsSchema,
  /** A style hint for chat, always placed below the platform's rules. */
  style: z.string().max(STUDIO_LIMITS.styleMax),
});
export type StudioConfig = z.infer<typeof StudioConfigSchema>;

export type AgentNameProblem = 'length' | 'characters' | 'person_name' | 'contact';
export type StyleProblem = 'too_long' | 'contact' | 'link';

const CONTACT = /@|\d[\d\s().-]{6,}\d|(?:https?:|www\.)|\.(?:com|net|org|io|app|gg|me)\b/i;

/**
 * Agents never claim to be a specific real person (CLAUDE.md invariant 13), so a name may not look like a
 * person's full name ("Jane Doe"), carry contact details, or use unusual characters. Single words such as
 * "Marlowe" are fine.
 */
export function checkAgentName(raw: string): AgentNameProblem | null {
  const name = raw.trim();
  if (name.length < STUDIO_LIMITS.nameMin || name.length > STUDIO_LIMITS.nameMax) return 'length';
  if (CONTACT.test(name)) return 'contact';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) return 'characters';
  if (/^\p{Lu}\p{Ll}+(?:[ ._-]+\p{Lu}\p{Ll}+)+$/u.test(name)) return 'person_name';
  return null;
}

export function checkStyleHint(style: string): StyleProblem | null {
  if (style.length > STUDIO_LIMITS.styleMax) return 'too_long';
  if (/(?:https?:|www\.)|\.(?:com|net|org|io|app|gg|me)\b/i.test(style)) return 'link';
  if (/@|\d[\d\s().-]{6,}\d/.test(style)) return 'contact';
  return null;
}

/** `studio:<agent id>:v<n>`: every saved change is a new, immutable version (SPEC §Agents, Studio). */
export const studioVersionLabel = (agentId: number, n: number): string => `studio:${agentId}:v${n}`;
export function parseStudioVersion(label: string): { agentId: number; n: number } | null {
  const m = /^studio:(\d+):v(\d+)$/.exec(label);
  return m ? { agentId: Number(m[1]), n: Number(m[2]) } : null;
}

// ---------- HTTP: /api/studio/* (signed-in, T2+; the leaderboard and names are public) ----------

export const StudioCreateRequestSchema = z.object({
  name: z.string().min(1).max(64),
  config: StudioConfigSchema,
  /** The Studio terms version the maker accepted (recorded as consent `studio`). */
  studioTermsVersion: z.literal(CONSENT_VERSIONS.studio),
});
export const StudioVersionRequestSchema = z.object({ config: StudioConfigSchema });

/** What a maker sees about their own agent: aggregates only, never match ids, players or messages. */
export const StudioStatsSchema = z.object({
  matches: z.number().int(),
  labels: z.number().int(),
  labeledHuman: z.number().int(),
  /** labeledHuman / labels, or null with no labels yet. */
  humanRate: z.number().nullable(),
  averageScore: z.number().nullable(),
  strikes: z.number().int(),
});
export type StudioStats = z.infer<typeof StudioStatsSchema>;

export const StudioAgentSummarySchema = z.object({
  agentId: z.number().int(),
  name: z.string(),
  status: z.enum(['active', 'paused', 'suspended', 'retired']),
  pausedReason: z.string().nullable(),
  version: z.string(),
  versionNumber: z.number().int(),
  config: StudioConfigSchema,
  /** Stats of the current version (each version's record starts fresh). */
  stats: StudioStatsSchema,
  /** Public matches in the last 24 hours, against STUDIO_LIMITS.matchesPerDay. */
  matchesToday: z.number().int(),
});
export type StudioAgentSummary = z.infer<typeof StudioAgentSummarySchema>;
export const StudioAgentListSchema = z.object({ agents: z.array(StudioAgentSummarySchema) });

export const LeaderboardSchema = z.object({
  minLabels: z.number().int(),
  entries: z.array(
    z.object({
      name: z.string(),
      versionNumber: z.number().int(),
      labels: z.number().int(),
      humanRate: z.number(),
    }),
  ),
});
export type Leaderboard = z.infer<typeof LeaderboardSchema>;

/** `GET /api/studio/names?v=…`: display names for Studio versions seen at Reveal. Public. */
export const StudioNamesSchema = z.record(
  z.string(),
  z.object({ name: z.string(), versionNumber: z.number() }),
);
