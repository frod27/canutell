import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  AccountError,
  addPasskey,
  answerAge,
  createAccount,
  createSession,
  deleteAccount,
  findPasskey,
  getAccount,
  inviteUsable,
  submitFeedback,
  listPasskeys,
  passkeyUsed,
  removePasskey,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  setConsent,
  userHandleOf,
  type PasskeyRecord,
  type Sql,
  type StoredPasskey,
} from '@canutell/db';
import {
  AgeRequestSchema,
  FeedbackRequestSchema,
  CeremonyVerifyRequestSchema,
  RegisterOptionsRequestSchema,
  ResearchConsentRequestSchema,
  SESSION_TOKEN_PATTERN,
  type AccountSummary,
  type PasskeyListResponse,
} from '@canutell/protocol';
import type { z } from 'zod';

// Passkey accounts over HTTP (DECISIONS "Phase 5 plan": our own WebAuthn, no email or phone).
//
//   POST   /api/auth/register/options   {termsVersion, invite?} → {flowId, options}   (invite: closed alpha)
//   POST   /api/auth/register/verify    {flowId, response}   → {session, account}   (new T1 account)
//   POST   /api/auth/login/options                           → {flowId, options}
//   POST   /api/auth/login/verify       {flowId, response}   → {session, account}
//   POST   /api/auth/logout                                  (this session)
//   GET    /api/me                                           → account
//   POST   /api/me/age                  {year, month}        → account   (answerable once)
//   PUT    /api/me/consent/research     {granted, version}   → account
//   GET    /api/me/passkeys                                  → {passkeys}
//   POST   /api/me/passkeys/options | /api/me/passkeys/verify  add another passkey
//   DELETE /api/me/passkeys/:id
//   POST   /api/me/sessions/revoke                           sign out everywhere
//   DELETE /api/me                                           delete the account (privacy deletion)
//   POST   /api/matches/:id/feedback    {fun, tags, comment} post-match survey (seated account, once)
//
// /api/me* need `Authorization: Bearer <session>`. Sign-in is usernameless (discoverable credentials), user
// verification is required, and attestation is `none`, so no authenticator model is collected.

/** The WebAuthn ceremonies, behind an interface so server tests can run them without a browser. */
export interface PasskeyCeremonies {
  registrationOptions(a: {
    userHandle: Uint8Array;
    userName: string;
    exclude: { id: string; transports: string[] }[];
  }): Promise<{ challenge: string }>;
  verifyRegistration(response: unknown, expectedChallenge: string): Promise<PasskeyRecord | null>;
  authenticationOptions(): Promise<{ challenge: string }>;
  verifyAuthentication(
    response: unknown,
    expectedChallenge: string,
    passkey: StoredPasskey,
  ): Promise<{ signCount: number; backedUp: boolean } | null>;
}

export interface WebAuthnConfig {
  /** Relying-party ID: the web client's registrable domain, e.g. `canutell.app` (`localhost` in dev). */
  rpId: string;
  rpName?: string;
  /** Exact web origins allowed to run ceremonies, e.g. `https://canutell.app`. */
  origins: string[];
}

export function simpleWebAuthn(cfg: WebAuthnConfig): PasskeyCeremonies {
  const rpName = cfg.rpName ?? 'CANUTELL';
  return {
    async registrationOptions(a) {
      return generateRegistrationOptions({
        rpName,
        rpID: cfg.rpId,
        userName: a.userName,
        userID: new Uint8Array(a.userHandle),
        attestationType: 'none',
        excludeCredentials: a.exclude,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
    },
    async verifyRegistration(response, expectedChallenge) {
      const r = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpId,
        requireUserVerification: true,
      }).catch(() => null);
      if (!r?.verified) return null;
      const info = r.registrationInfo;
      return {
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        signCount: info.credential.counter,
        transports: info.credential.transports ?? [],
        multiDevice: info.credentialDeviceType === 'multiDevice',
        backedUp: info.credentialBackedUp,
      };
    },
    async authenticationOptions() {
      return generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: 'required' });
    },
    async verifyAuthentication(response, expectedChallenge, passkey) {
      const r = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: cfg.origins,
        expectedRPID: cfg.rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.signCount,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      }).catch(() => null);
      if (!r?.verified) return null;
      return {
        signCount: r.authenticationInfo.newCounter,
        backedUp: r.authenticationInfo.credentialBackedUp,
      };
    },
  };
}

interface Flow {
  kind: 'register' | 'login' | 'add';
  challenge: string;
  expiresAt: number;
  userHandle?: Uint8Array;
  termsVersion?: number;
  invite?: string;
  playerId?: string;
}

const FLOW_TTL_MS = 5 * 60_000;
const MAX_FLOWS = 10_000;
const MAX_BODY = 64 * 1024;

export interface AccountsApiOptions {
  sql: Sql;
  ceremonies: PasskeyCeremonies;
  /** Wall clock for sessions and consent timestamps (not the game clock). */
  now?: () => number;
  log?: (msg: string) => void;
  /** Called after an account is deleted or signs out everywhere, so live sockets can be dropped. */
  onSessionsRevoked?: (playerId: string) => void;
  /** Closed alpha: sign-up needs a valid invite code (DECISIONS Phase 6). */
  invitesRequired?: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

export class AccountsApi {
  private readonly flows = new Map<string, Flow>();
  private readonly now: () => number;

  constructor(private readonly o: AccountsApiOptions) {
    this.now = o.now ?? Date.now;
  }

  /** The account behind a session token, or null. Every use re-checks the database (revocation is immediate). */
  resolve(token: string): Promise<AccountSummary | null> {
    return SESSION_TOKEN_PATTERN.test(token)
      ? resolveSession(this.o.sql, token, this.now())
      : Promise.resolve(null);
  }

  /** Handles /api/auth/* and /api/me*. Returns false for any other path. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    reply: (status: number, body?: unknown) => void,
  ): boolean {
    const feedback = /^\/api\/matches\/[A-Za-z0-9-]{1,128}\/feedback$/.test(path);
    if (!feedback && !path.startsWith('/api/auth/') && path !== '/api/me' && !path.startsWith('/api/me/'))
      return false;
    this.route(req, path).then(
      ([status, body]) => reply(status, body),
      (e) => {
        if (e instanceof HttpError) return reply(e.status, { error: e.code });
        if (e instanceof AccountError) {
          const status = e.code === 'not_found' ? 404 : 409;
          return reply(status, { error: e.code });
        }
        this.o.log?.(`accounts api ${req.method} ${path} failed: ${String(e)}`);
        reply(500, { error: 'internal_error' });
      },
    );
    return true;
  }

  private async route(req: IncomingMessage, path: string): Promise<[number, unknown]> {
    const m = req.method;
    const sql = this.o.sql;
    if (m === 'POST' && path === '/api/auth/register/options') {
      const body = await this.body(req, RegisterOptionsRequestSchema);
      // Checked before the passkey ceremony (nothing consumed); redeemed atomically when the account is made.
      if (this.o.invitesRequired && !(body.invite && (await inviteUsable(sql, body.invite, this.now()))))
        throw new HttpError(403, 'invalid_invite');
      const userHandle = randomBytes(32);
      const tag = randomBytes(3).toString('hex').toUpperCase();
      const options = await this.o.ceremonies.registrationOptions({
        userHandle,
        userName: `CANUTELL player ${tag}`,
        exclude: [],
      });
      return [
        200,
        {
          flowId: this.startFlow({
            kind: 'register',
            challenge: options.challenge,
            userHandle,
            termsVersion: body.termsVersion,
            invite: this.o.invitesRequired ? body.invite : undefined,
          }),
          options,
        },
      ];
    }
    if (m === 'POST' && path === '/api/auth/register/verify') {
      const body = await this.body(req, CeremonyVerifyRequestSchema);
      const flow = this.takeFlow(body.flowId, 'register');
      const passkey = await this.o.ceremonies.verifyRegistration(body.response, flow.challenge);
      if (!passkey) throw new HttpError(400, 'passkey_not_verified');
      const now = this.now();
      const playerId = await createAccount(sql, {
        userHandle: flow.userHandle!,
        passkey,
        termsVersion: flow.termsVersion!,
        now,
        invite: flow.invite,
      });
      return [200, await this.session(playerId)];
    }
    if (m === 'POST' && path === '/api/auth/login/options') {
      const options = await this.o.ceremonies.authenticationOptions();
      return [200, { flowId: this.startFlow({ kind: 'login', challenge: options.challenge }), options }];
    }
    if (m === 'POST' && path === '/api/auth/login/verify') {
      const body = await this.body(req, CeremonyVerifyRequestSchema);
      const flow = this.takeFlow(body.flowId, 'login');
      const passkey = await findPasskey(sql, body.response.id);
      if (!passkey) throw new HttpError(401, 'unknown_passkey');
      // A discoverable credential returns the user handle it was created for; it must be this account's.
      const handle = (body.response.response as { userHandle?: unknown }).userHandle;
      if (typeof handle === 'string' && handle !== Buffer.from(passkey.userHandle).toString('base64url'))
        throw new HttpError(401, 'unknown_passkey');
      const ok = await this.o.ceremonies.verifyAuthentication(body.response, flow.challenge, passkey);
      if (!ok) throw new HttpError(401, 'passkey_not_verified');
      await passkeyUsed(sql, passkey.credentialId, { ...ok, now: this.now() });
      if (!(await getAccount(sql, passkey.playerId))) throw new HttpError(401, 'unknown_passkey');
      return [200, await this.session(passkey.playerId)];
    }

    // Everything below needs a live session.
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'missing_session');
    const account = await this.resolve(token);
    if (!account) throw new HttpError(401, 'invalid_session');
    const me = account.playerId;

    if (m === 'POST' && path === '/api/auth/logout') {
      await revokeSession(sql, token, this.now());
      return [204, undefined];
    }
    if (m === 'GET' && path === '/api/me') return [200, account];
    const fb = /^\/api\/matches\/([A-Za-z0-9-]{1,128})\/feedback$/.exec(path);
    if (m === 'POST' && fb) {
      const body = await this.body(req, FeedbackRequestSchema);
      await submitFeedback(sql, { ...body, matchId: fb[1]!, playerId: me, now: this.now() });
      return [204, undefined];
    }
    if (m === 'POST' && path === '/api/me/age') {
      const body = await this.body(req, AgeRequestSchema);
      return [200, await answerAge(sql, me, { ...body, now: this.now() })];
    }
    if (m === 'PUT' && path === '/api/me/consent/research') {
      const body = await this.body(req, ResearchConsentRequestSchema);
      await setConsent(sql, me, 'research', body.granted, this.now());
      return [200, await getAccount(sql, me)];
    }
    if (m === 'GET' && path === '/api/me/passkeys') {
      const keys = await listPasskeys(sql, me);
      const out: PasskeyListResponse = {
        passkeys: keys.map((k) => ({
          id: k.credentialId,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          multiDevice: k.multiDevice,
          backedUp: k.backedUp,
        })),
      };
      return [200, out];
    }
    if (m === 'POST' && path === '/api/me/passkeys/options') {
      const userHandle = await userHandleOf(sql, me);
      if (!userHandle) throw new HttpError(401, 'invalid_session');
      const existing = await listPasskeys(sql, me);
      const options = await this.o.ceremonies.registrationOptions({
        userHandle,
        userName: 'CANUTELL player',
        exclude: existing.map((k) => ({ id: k.credentialId, transports: k.transports })),
      });
      return [
        200,
        { flowId: this.startFlow({ kind: 'add', challenge: options.challenge, playerId: me }), options },
      ];
    }
    if (m === 'POST' && path === '/api/me/passkeys/verify') {
      const body = await this.body(req, CeremonyVerifyRequestSchema);
      const flow = this.takeFlow(body.flowId, 'add');
      if (flow.playerId !== me) throw new HttpError(400, 'unknown_flow');
      const passkey = await this.o.ceremonies.verifyRegistration(body.response, flow.challenge);
      if (!passkey) throw new HttpError(400, 'passkey_not_verified');
      await addPasskey(sql, me, passkey, this.now());
      return [204, undefined];
    }
    const del = /^\/api\/me\/passkeys\/([A-Za-z0-9_-]{1,1024})$/.exec(path);
    if (m === 'DELETE' && del) {
      await removePasskey(sql, me, del[1]!);
      return [204, undefined];
    }
    if (m === 'POST' && path === '/api/me/sessions/revoke') {
      await revokeAllSessions(sql, me, this.now());
      this.o.onSessionsRevoked?.(me);
      return [204, undefined];
    }
    if (m === 'DELETE' && path === '/api/me') {
      await deleteAccount(sql, me, this.now());
      this.o.onSessionsRevoked?.(me);
      return [204, undefined];
    }
    throw new HttpError(404, 'not_found');
  }

  private async session(playerId: string): Promise<{ session: string; account: AccountSummary }> {
    const session = await createSession(this.o.sql, playerId, this.now());
    return { session, account: (await getAccount(this.o.sql, playerId))! };
  }

  private startFlow(f: Omit<Flow, 'expiresAt'>): string {
    const now = this.now();
    for (const [id, x] of this.flows) if (x.expiresAt <= now) this.flows.delete(id);
    if (this.flows.size >= MAX_FLOWS) throw new HttpError(503, 'busy');
    const id = randomBytes(18).toString('base64url');
    this.flows.set(id, { ...f, expiresAt: now + FLOW_TTL_MS });
    return id;
  }

  /** Single use: a flow is consumed whether or not its ceremony then verifies. */
  private takeFlow(id: string, kind: Flow['kind']): Flow {
    const f = this.flows.get(id);
    this.flows.delete(id);
    if (!f || f.kind !== kind || f.expiresAt <= this.now()) throw new HttpError(400, 'unknown_flow');
    return f;
  }

  private body<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'too_large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const raw = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          const parsed = schema.safeParse(raw);
          if (!parsed.success) return reject(new HttpError(400, 'invalid_request'));
          resolve(parsed.data);
        } catch {
          reject(new HttpError(400, 'invalid_json'));
        }
      });
      req.on('error', reject);
    });
  }
}
