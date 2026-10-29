import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CONSENT_VERSIONS,
  SESSION_TOKEN_PATTERN,
  TRUST_ORDER,
  type AccountSummary,
  type ConsentType,
  type TrustLevel,
} from '@canutell/protocol';
import { EXCLUDED_FLAGS } from './latency-model';
import { iso } from './queries';
import type { Sql } from './sql';

// Accounts, sessions, consents and trust levels (SPEC §Integrity, §Consent and privacy; DECISIONS Phase 5).
//
// Identity data (user handle, passkeys, sessions, age answer) lives in the `identity` schema, which no
// export role can read and no training view joins (CLAUDE.md invariant 9). No email, phone or birth date is
// ever stored. Trust changes are logged in the append-only trust_changes table.

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** SPEC §Integrity, T3: this many consecutive clean, completed, non-dev matches at T2+. */
export const T3_CLEAN_MATCHES = 10;

export class AccountError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'age_already_answered'
      | 'age_try_later'
      | 'last_passkey'
      | 'not_flagged'
      | 'not_reviewable'
      | 'bad_level',
    message: string,
  ) {
    super(message);
  }
}

export interface PasskeyRecord {
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  multiDevice: boolean;
  backedUp: boolean;
}

export interface StoredPasskey extends PasskeyRecord {
  playerId: string;
  userHandle: Uint8Array;
  createdAt: number;
  lastUsedAt: number | null;
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const bytes = (v: unknown): Uint8Array => new Uint8Array(v as ArrayLike<number>);
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();
const lower = (l: TrustLevel): TrustLevel => TRUST_ORDER[Math.max(0, TRUST_ORDER.indexOf(l) - 1)]!;

async function setTrust(
  tx: Sql,
  playerId: string,
  from: TrustLevel,
  to: TrustLevel,
  reason: string,
  now: number,
  matchId: string | null = null,
): Promise<void> {
  if (from === to) return;
  await tx.query('update players set trust_level = $2 where player_id = $1', [playerId, to]);
  await tx.query(
    `insert into trust_changes (player_id, from_level, to_level, reason, match_id, at)
     values ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [playerId, from, to, reason, matchId, iso(now)],
  );
}

// ---------- accounts ----------

/**
 * A new passkey account at T1, with its terms consent (SPEC: T1 = signed-in account). `userHandle` is the
 * random WebAuthn user.id the passkey was created for.
 */
export async function createAccount(
  sql: Sql,
  a: { userHandle: Uint8Array; passkey: PasskeyRecord; termsVersion: number; now: number },
): Promise<string> {
  const playerId = `p_${randomUUID()}`;
  await sql.transaction(async (tx) => {
    await tx.query(`insert into players (player_id, created_at) values ($1, $2::timestamptz)`, [
      playerId,
      iso(a.now),
    ]);
    await tx.query(
      `insert into identity.identities (player_id, user_handle, verification_method, verified_at)
       values ($1, $2, 'passkey', $3::timestamptz)`,
      [playerId, Buffer.from(a.userHandle), iso(a.now)],
    );
    await insertPasskey(tx, playerId, a.passkey, a.now);
    await tx.query(
      `insert into consents (player_id, consent_type, version, granted_at) values ($1, 'terms', $2, $3::timestamptz)`,
      [playerId, a.termsVersion, iso(a.now)],
    );
    await setTrust(tx, playerId, 'T0', 'T1', 'account_created', a.now);
  });
  return playerId;
}

async function insertPasskey(tx: Sql, playerId: string, p: PasskeyRecord, now: number): Promise<void> {
  await tx.query(
    `insert into identity.passkeys (credential_id, player_id, public_key, sign_count, transports, multi_device,
       backed_up, created_at)
     values ($1, $2, $3, $4, $5::text[], $6, $7, $8::timestamptz)`,
    [
      p.credentialId,
      playerId,
      Buffer.from(p.publicKey),
      p.signCount,
      p.transports,
      p.multiDevice,
      p.backedUp,
      iso(now),
    ],
  );
}

export async function addPasskey(sql: Sql, playerId: string, p: PasskeyRecord, now: number): Promise<void> {
  await insertPasskey(sql, playerId, p, now);
}

export async function findPasskey(sql: Sql, credentialId: string): Promise<StoredPasskey | null> {
  const [r] = await sql.query<Record<string, unknown>>(
    `select k.*, i.user_handle from identity.passkeys k join identity.identities i using (player_id)
      where k.credential_id = $1`,
    [credentialId],
  );
  if (!r) return null;
  return {
    credentialId: r.credential_id as string,
    playerId: r.player_id as string,
    userHandle: bytes(r.user_handle),
    publicKey: bytes(r.public_key),
    signCount: Number(r.sign_count),
    transports: r.transports as string[],
    multiDevice: r.multi_device as boolean,
    backedUp: r.backed_up as boolean,
    createdAt: ms(r.created_at),
    lastUsedAt: r.last_used_at === null ? null : ms(r.last_used_at),
  };
}

export async function userHandleOf(sql: Sql, playerId: string): Promise<Uint8Array | null> {
  const [r] = await sql.query<{ user_handle: unknown }>(
    'select user_handle from identity.identities where player_id = $1',
    [playerId],
  );
  return r ? bytes(r.user_handle) : null;
}

export async function passkeyUsed(
  sql: Sql,
  credentialId: string,
  p: { signCount: number; backedUp: boolean; now: number },
): Promise<void> {
  await sql.query(
    `update identity.passkeys set sign_count = $2, backed_up = $3, last_used_at = $4::timestamptz
      where credential_id = $1`,
    [credentialId, p.signCount, p.backedUp, iso(p.now)],
  );
}

export async function listPasskeys(sql: Sql, playerId: string): Promise<StoredPasskey[]> {
  const rows = await sql.query<{ credential_id: string }>(
    'select credential_id from identity.passkeys where player_id = $1 order by created_at, credential_id',
    [playerId],
  );
  const out: StoredPasskey[] = [];
  for (const r of rows) out.push((await findPasskey(sql, r.credential_id))!);
  return out;
}

/** Remove one of the player's passkeys. The last one can't be removed (delete the account instead). */
export async function removePasskey(sql: Sql, playerId: string, credentialId: string): Promise<void> {
  await sql.transaction(async (tx) => {
    const keys = await tx.query<{ credential_id: string }>(
      'select credential_id from identity.passkeys where player_id = $1 for update',
      [playerId],
    );
    if (!keys.some((k) => k.credential_id === credentialId))
      throw new AccountError('not_found', 'no such passkey');
    if (keys.length === 1) throw new AccountError('last_passkey', 'an account needs at least one passkey');
    await tx.query('delete from identity.passkeys where credential_id = $1 and player_id = $2', [
      credentialId,
      playerId,
    ]);
  });
}

export async function getAccount(sql: Sql, playerId: string): Promise<AccountSummary | null> {
  const [r] = await sql.query<{ trust_level: TrustLevel; age_confirmed: boolean | null; research: boolean }>(
    `select p.trust_level, i.age_confirmed,
            exists (select 1 from active_research_consent c where c.player_id = p.player_id) as research
       from players p join identity.identities i using (player_id)
      where p.player_id = $1 and p.deleted_at is null`,
    [playerId],
  );
  if (!r) return null;
  return {
    playerId,
    trustLevel: r.trust_level,
    ageConfirmed: r.age_confirmed,
    researchConsent: r.research,
  };
}

/** Current trust of several players (for trust_level_at_match). Unknown or deleted ids are left out. */
export async function trustLevels(sql: Sql, playerIds: readonly string[]): Promise<Map<string, TrustLevel>> {
  const rows = await sql.query<{ player_id: string; trust_level: TrustLevel }>(
    'select player_id, trust_level from players where player_id = any($1::text[]) and deleted_at is null',
    [[...playerIds]],
  );
  return new Map(rows.map((r) => [r.player_id, r.trust_level]));
}

// ---------- sessions ----------

export async function createSession(sql: Sql, playerId: string, now: number): Promise<string> {
  const token = `s_${randomBytes(32).toString('hex')}`;
  await sql.query(
    `insert into identity.sessions (token_hash, player_id, created_at, expires_at)
     values ($1, $2, $3::timestamptz, $4::timestamptz)`,
    [hashToken(token), playerId, iso(now), iso(now + SESSION_TTL_MS)],
  );
  return token;
}

/** The account behind a live session token, or null (unknown, expired, revoked, deleted). */
export async function resolveSession(sql: Sql, token: string, now: number): Promise<AccountSummary | null> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const [r] = await sql.query<{ player_id: string }>(
    `select player_id from identity.sessions
      where token_hash = $1 and revoked_at is null and expires_at > $2::timestamptz`,
    [hashToken(token), iso(now)],
  );
  return r ? getAccount(sql, r.player_id) : null;
}

export async function revokeSession(sql: Sql, token: string, now: number): Promise<void> {
  await sql.query(
    'update identity.sessions set revoked_at = $2::timestamptz where token_hash = $1 and revoked_at is null',
    [hashToken(token), iso(now)],
  );
}

export async function revokeAllSessions(sql: Sql, playerId: string, now: number): Promise<void> {
  await sql.query(
    'update identity.sessions set revoked_at = $2::timestamptz where player_id = $1 and revoked_at is null',
    [playerId, iso(now)],
  );
}

// ---------- age and consent ----------

/**
 * Age from a birth month and year at `now` (UTC): 'adult', 'minor', or 'unsure' in the month of the 18th
 * birthday, when the day decides. 'unsure' stores nothing, so the player can answer again next month.
 */
export function ageStatus(year: number, month: number, now: number): 'adult' | 'minor' | 'unsure' {
  const d = new Date(now);
  const months = (d.getUTCFullYear() - year) * 12 + (d.getUTCMonth() + 1 - month);
  return months > 18 * 12 ? 'adult' : months === 18 * 12 ? 'unsure' : 'minor';
}

/**
 * Self-attested age (DECISIONS "Phase 5 plan"). Only true/false is stored, never the date. Answerable once:
 * an under-18 account stays T1 (play only). An adult T1 account becomes T2.
 */
export async function answerAge(
  sql: Sql,
  playerId: string,
  a: { year: number; month: number; now: number },
): Promise<AccountSummary> {
  await sql.transaction(async (tx) => {
    const [r] = await tx.query<{ age_confirmed: boolean | null; trust_level: TrustLevel }>(
      `select i.age_confirmed, p.trust_level from identity.identities i join players p using (player_id)
        where player_id = $1 and p.deleted_at is null for update`,
      [playerId],
    );
    if (!r) throw new AccountError('not_found', 'no such account');
    if (r.age_confirmed !== null) throw new AccountError('age_already_answered', 'age was already answered');
    const status = ageStatus(a.year, a.month, a.now);
    if (status === 'unsure')
      throw new AccountError(
        'age_try_later',
        'this is the month of the 18th birthday; answer again next month',
      );
    const adult = status === 'adult';
    await tx.query(
      `update identity.identities set age_confirmed = $2, age_method = 'self_attested',
         age_answered_at = $3::timestamptz where player_id = $1`,
      [playerId, adult, iso(a.now)],
    );
    if (adult && r.trust_level === 'T1') await setTrust(tx, playerId, 'T1', 'T2', 'age_confirmed', a.now);
  });
  return (await getAccount(sql, playerId))!;
}

export async function setConsent(
  sql: Sql,
  playerId: string,
  type: ConsentType,
  granted: boolean,
  now: number,
): Promise<void> {
  await sql.transaction(async (tx) => {
    const [active] = await tx.query<{ consent_id: number; version: number }>(
      `select consent_id, version from consents
        where player_id = $1 and consent_type = $2 and revoked_at is null for update`,
      [playerId, type],
    );
    const version = CONSENT_VERSIONS[type];
    if (granted && active?.version === version) return;
    if (active)
      await tx.query('update consents set revoked_at = $2::timestamptz where consent_id = $1', [
        active.consent_id,
        iso(now),
      ]);
    if (granted)
      await tx.query(
        `insert into consents (player_id, consent_type, version, granted_at) values ($1, $2, $3, $4::timestamptz)`,
        [playerId, type, version, iso(now)],
      );
  });
}

// ---------- deletion (DECISIONS "Guests and deleted accounts") ----------

/**
 * Erases identity, passkeys and sessions, revokes every consent, and removes the player's integrity data.
 * Their past seats stay in the match logs only as anonymous context, never exported, like a guest's.
 */
export async function deleteAccount(sql: Sql, playerId: string, now: number): Promise<void> {
  await sql.transaction(async (tx) => {
    const [p] = await tx.query<{ trust_level: TrustLevel }>(
      'select trust_level from players where player_id = $1 and deleted_at is null for update',
      [playerId],
    );
    if (!p) throw new AccountError('not_found', 'no such account');
    await tx.exec(`set local canutell.privacy_deletion = 'on'`);
    await tx.query('delete from identity.identities where player_id = $1', [playerId]);
    await tx.query(
      'update consents set revoked_at = $2::timestamptz where player_id = $1 and revoked_at is null',
      [playerId, iso(now)],
    );
    for (const t of ['client_signals', 'integrity_signals'])
      await tx.query(
        `delete from ${t} x using seats s
          where s.match_id = x.match_id and s.seat_id = x.seat_id and s.player_id = $1`,
        [playerId],
      );
    await tx.query('update players set deleted_at = $2::timestamptz where player_id = $1', [
      playerId,
      iso(now),
    ]);
    await setTrust(tx, playerId, p.trust_level, 'T0', 'account_deleted', now);
  });
}

// ---------- trust after a match (SPEC §Integrity) ----------

const CLEAN_SEAT = `
  not exists (
    select 1 from integrity_signals i
      left join seat_review_status r on r.match_id = i.match_id and r.seat_id = i.seat_id
     where i.match_id = s.match_id and i.seat_id = s.seat_id and i.flagged
       and r.decision is distinct from 'cleared')`;

/**
 * Applies a finished match to its account holders' trust, once (idempotent per player and match):
 * - a flagged seat lowers its player one level (T3 → T2, T2 → T1) until a reviewer decides;
 * - otherwise a T2 player whose last 10 completed non-dev matches at T2+ are all clean becomes T3.
 * Runs after the match's derived rows (and status) are written, in the same transaction.
 */
export async function applyMatchTrust(tx: Sql, matchId: string, now: number): Promise<void> {
  const seats = await tx.query<{ player_id: string; trust_level: TrustLevel; flagged: boolean }>(
    `select s.player_id, p.trust_level, not (${CLEAN_SEAT}) as flagged
       from seats s join players p on p.player_id = s.player_id
      where s.match_id = $1 and s.kind = 'human' and s.trust_level_at_match >= 'T1' and p.deleted_at is null
        and not exists (select 1 from trust_changes c where c.player_id = s.player_id and c.match_id = $1)
      for update of p`,
    [matchId],
  );
  for (const s of seats) {
    if (s.flagged) {
      if (s.trust_level === 'T2' || s.trust_level === 'T3')
        await setTrust(tx, s.player_id, s.trust_level, lower(s.trust_level), 'automation_flag', now, matchId);
      continue;
    }
    if (s.trust_level !== 'T2') continue;
    const recent = await tx.query<{ clean: boolean }>(
      `select ${CLEAN_SEAT} as clean
         from seats s join matches m on m.match_id = s.match_id
        where s.player_id = $1 and s.trust_level_at_match >= 'T2' and m.status = 'completed'
          and not (m.flags && $2::text[])
        order by m.created_at desc, m.match_id desc
        limit ${T3_CLEAN_MATCHES}`,
      [s.player_id, [...EXCLUDED_FLAGS]],
    );
    if (recent.length === T3_CLEAN_MATCHES && recent.every((r) => r.clean))
      await setTrust(tx, s.player_id, 'T2', 'T3', 'clean_matches', now, matchId);
  }
}

// ---------- human review of flagged seats ----------

export interface PendingReview {
  matchId: string;
  seat: number;
  matchCreatedAt: number;
  signals: { signal: string; value: number }[];
}

/** Account holders' flagged seats with no review yet. No identity data (the reviewer judges behaviour). */
export async function pendingReviews(sql: Sql): Promise<PendingReview[]> {
  const rows = await sql.query<{
    match_id: string;
    seat_id: number;
    created_at: unknown;
    signal: string;
    value: number;
  }>(
    `select i.match_id, i.seat_id, m.created_at, i.signal, i.value
       from integrity_signals i
       join seats s on s.match_id = i.match_id and s.seat_id = i.seat_id
       join matches m on m.match_id = i.match_id
      where i.flagged and s.kind = 'human'
        and not exists (select 1 from integrity_reviews r where r.match_id = i.match_id and r.seat_id = i.seat_id)
      order by m.created_at, i.match_id, i.seat_id, i.signal`,
  );
  const out: PendingReview[] = [];
  for (const r of rows) {
    let last = out[out.length - 1];
    if (!last || last.matchId !== r.match_id || last.seat !== r.seat_id) {
      last = { matchId: r.match_id, seat: r.seat_id, matchCreatedAt: ms(r.created_at), signals: [] };
      out.push(last);
    }
    last.signals.push({ signal: r.signal, value: r.value });
  }
  return out;
}

/**
 * Records a reviewer's decision on a flagged seat. `cleared` undoes that match's automatic lowering (if the
 * player is still at the lowered level); `confirmed` sets the player to T1. Nobody is ever banned.
 */
export async function reviewSeat(
  sql: Sql,
  r: {
    matchId: string;
    seat: number;
    decision: 'cleared' | 'confirmed';
    reviewer: string;
    note?: string;
    now: number;
  },
): Promise<void> {
  await sql.transaction(async (tx) => {
    const [seat] = await tx.query<{ player_id: string | null; kind: string; flagged: boolean }>(
      `select s.player_id, s.kind,
              exists (select 1 from integrity_signals i
                       where i.match_id = s.match_id and i.seat_id = s.seat_id and i.flagged) as flagged
         from seats s where s.match_id = $1 and s.seat_id = $2`,
      [r.matchId, r.seat],
    );
    if (!seat) throw new AccountError('not_found', 'no such seat');
    if (seat.kind !== 'human' || !seat.player_id)
      throw new AccountError('not_reviewable', 'not a human seat');
    if (!seat.flagged) throw new AccountError('not_flagged', 'this seat has no automation flag');
    await tx.query(
      `insert into integrity_reviews (match_id, seat_id, decision, reviewer, note, decided_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [r.matchId, r.seat, r.decision, r.reviewer, r.note ?? null, iso(r.now)],
    );
    const [p] = await tx.query<{ trust_level: TrustLevel; deleted: boolean }>(
      'select trust_level, deleted_at is not null as deleted from players where player_id = $1 for update',
      [seat.player_id],
    );
    if (!p || p.deleted) return;
    if (r.decision === 'confirmed') {
      if (p.trust_level === 'T2' || p.trust_level === 'T3')
        await setTrust(tx, seat.player_id, p.trust_level, 'T1', 'review_confirmed', r.now, r.matchId);
      return;
    }
    const [lowered] = await tx.query<{ from_level: TrustLevel; to_level: TrustLevel }>(
      `select from_level, to_level from trust_changes
        where player_id = $1 and match_id = $2 and reason = 'automation_flag'
        order by change_id desc limit 1`,
      [seat.player_id, r.matchId],
    );
    if (lowered && p.trust_level === lowered.to_level)
      await setTrust(
        tx,
        seat.player_id,
        p.trust_level,
        lowered.from_level,
        'review_cleared',
        r.now,
        r.matchId,
      );
  });
}

/** A reviewer restores a player's level by hand (e.g. after a confirmed flag is overturned). */
export async function restoreTrust(
  sql: Sql,
  r: { playerId: string; level: 'T1' | 'T2' | 'T3'; now: number },
): Promise<void> {
  await sql.transaction(async (tx) => {
    const [p] = await tx.query<{ trust_level: TrustLevel; age_confirmed: boolean | null }>(
      `select p.trust_level, i.age_confirmed from players p join identity.identities i using (player_id)
        where p.player_id = $1 and p.deleted_at is null for update of p`,
      [r.playerId],
    );
    if (!p) throw new AccountError('not_found', 'no such account');
    if (r.level !== 'T1' && p.age_confirmed !== true)
      throw new AccountError('bad_level', 'T2 and above need a confirmed 18+ answer');
    await setTrust(tx, r.playerId, p.trust_level, r.level, 'reviewer_restored', r.now);
  });
}
