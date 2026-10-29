'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  AccountSummarySchema,
  CeremonyOptionsResponseSchema,
  CONSENT_VERSIONS,
  PasskeyListResponseSchema,
  SessionResponseSchema,
  type AccountSummary,
  type PasskeyListResponse,
} from '@canutell/protocol';
import { serverHttpUrl } from './useGame';

// Passkey accounts (DECISIONS Phase 5). The session token lives in localStorage on this device only; it is
// sent as a Bearer token over HTTP and in the WebSocket hello. No cookies.

const SESSION_KEY = 'canutell.session';

export function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
export function writeSession(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session won't survive a reload */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
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
  if (!res.ok) {
    if (res.status === 401 && session && path.startsWith('/api/me')) writeSession(null);
    throw new ApiError(res.status, (json as { error?: string } | undefined)?.error ?? `http_${res.status}`);
  }
  return json;
}

/** Create a passkey and a T1 account. The player has accepted terms version `CONSENT_VERSIONS.terms`. */
export async function signUp(): Promise<AccountSummary> {
  const o = CeremonyOptionsResponseSchema.parse(
    await api('POST', '/api/auth/register/options', { termsVersion: CONSENT_VERSIONS.terms }),
  );
  const response = await startRegistration({ optionsJSON: o.options as never });
  const r = SessionResponseSchema.parse(
    await api('POST', '/api/auth/register/verify', { flowId: o.flowId, response }),
  );
  writeSession(r.session);
  return r.account;
}

export async function signIn(): Promise<AccountSummary> {
  const o = CeremonyOptionsResponseSchema.parse(await api('POST', '/api/auth/login/options'));
  const response = await startAuthentication({ optionsJSON: o.options as never });
  const r = SessionResponseSchema.parse(
    await api('POST', '/api/auth/login/verify', { flowId: o.flowId, response }),
  );
  writeSession(r.session);
  return r.account;
}

export const getMe = async () => AccountSummarySchema.parse(await api('GET', '/api/me'));

export const answerAge = async (year: number, month: number) =>
  AccountSummarySchema.parse(await api('POST', '/api/me/age', { year, month }));

export const setResearchConsent = async (granted: boolean) =>
  AccountSummarySchema.parse(
    await api('PUT', '/api/me/consent/research', { granted, version: CONSENT_VERSIONS.research }),
  );

export const listPasskeys = async (): Promise<PasskeyListResponse> =>
  PasskeyListResponseSchema.parse(await api('GET', '/api/me/passkeys'));

export async function addPasskey(): Promise<void> {
  const o = CeremonyOptionsResponseSchema.parse(await api('POST', '/api/me/passkeys/options'));
  const response = await startRegistration({ optionsJSON: o.options as never });
  await api('POST', '/api/me/passkeys/verify', { flowId: o.flowId, response });
}

export const removePasskey = (id: string) => api('DELETE', `/api/me/passkeys/${encodeURIComponent(id)}`);

export async function signOut(): Promise<void> {
  await api('POST', '/api/auth/logout').catch(() => {});
  writeSession(null);
}

export async function signOutEverywhere(): Promise<void> {
  await api('POST', '/api/me/sessions/revoke');
  writeSession(null);
}

export async function deleteAccount(): Promise<void> {
  await api('DELETE', '/api/me');
  writeSession(null);
}

export const TRUST_MEANING: Record<AccountSummary['trustLevel'], string> = {
  T0: 'Guest. Play only; nothing about you is kept after a match.',
  T1: 'Signed in. Play only; your match history is kept for you, never used for training.',
  T2: 'Verified 18+. With research consent, your play can help train CANUTELL’s AI players.',
  T3: 'Trusted: many clean matches at T2. With research consent, your play can also be used in research.',
};
