'use client';

import {
  CONSENT_VERSIONS,
  LeaderboardSchema,
  StudioAgentListSchema,
  StudioNamesSchema,
  type StudioConfig,
} from '@canutell/protocol';
import { readSession } from './account';
import { serverHttpUrl } from './useGame';

// Agent Studio (Phase 7; SPEC §Agents, Studio). Makers see aggregates only.

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const session = readSession();
  const res = await fetch(`${serverHttpUrl()}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok)
    throw new StudioApiError(
      res.status,
      (json as { error?: string } | undefined)?.error ?? `http_${res.status}`,
    );
  return json;
}

export const myAgents = async () =>
  StudioAgentListSchema.parse(await call('GET', '/api/studio/agents')).agents;
export const createAgent = async (name: string, config: StudioConfig) =>
  StudioAgentListSchema.parse(
    await call('POST', '/api/studio/agents', { name, config, studioTermsVersion: CONSENT_VERSIONS.studio }),
  ).agents;
export const saveVersion = async (agentId: number, config: StudioConfig) =>
  StudioAgentListSchema.parse(await call('POST', `/api/studio/agents/${agentId}/versions`, { config }))
    .agents;
export const retireAgent = async (agentId: number) =>
  StudioAgentListSchema.parse(await call('POST', `/api/studio/agents/${agentId}/retire`)).agents;
export const leaderboard = async () => LeaderboardSchema.parse(await call('GET', '/api/studio/leaderboard'));

/** Display names for the Studio versions in a reveal (public). */
export async function studioNames(
  versions: string[],
): Promise<Record<string, { name: string; versionNumber: number }>> {
  const wanted = versions.filter((v) => v.startsWith('studio:'));
  if (wanted.length === 0) return {};
  return StudioNamesSchema.parse(
    await call('GET', `/api/studio/names?v=${encodeURIComponent(wanted.join(','))}`),
  );
}

export function studioErrorText(code: string): string {
  return (
    {
      not_eligible: 'Studio agents need an account that has confirmed it is 18 or older.',
      too_many_agents: 'You already have 3 agents. Retire one to make another.',
      bad_name:
        'That name isn’t allowed. Use 3–24 letters or numbers, not a person’s full name or contact details.',
      name_taken: 'That name is taken.',
      bad_style: 'The style hint can’t contain links or contact details (300 characters at most).',
      retired: 'This agent is retired.',
      suspended: 'The moderators suspended this agent. You can retire it.',
      rate_limited: 'Too many changes for now. Please wait a while and try again.',
      invalid_session: 'Please sign in again.',
    }[code] ?? `Something went wrong (${code}).`
  );
}

export const TRAIT_LABELS: { key: keyof StudioConfig['traits']; label: string; low: string; high: string }[] =
  [
    { key: 'cooperativeness', label: 'Cooperation', low: 'keeps coins', high: 'shares freely' },
    { key: 'reciprocity', label: 'Reciprocity', low: 'goes its own way', high: 'mirrors others' },
    { key: 'riskAppetite', label: 'Risk', low: 'plays safe', high: 'gambles' },
    { key: 'patience', label: 'Patience', low: 'wants it now', high: 'waits for more' },
    { key: 'votePropensity', label: 'Voting', low: 'rarely votes', high: 'votes often' },
    { key: 'chattiness', label: 'Chattiness', low: 'quiet', high: 'talkative' },
    { key: 'randomness', label: 'Unpredictability', low: 'consistent', high: 'erratic' },
  ];

export const DEFAULT_CONFIG: StudioConfig = {
  traits: {
    cooperativeness: 0.5,
    reciprocity: 0.5,
    riskAppetite: 0.5,
    patience: 0.5,
    votePropensity: 0.5,
    chattiness: 0.5,
    randomness: 0.5,
  },
  style: '',
};
