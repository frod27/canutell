import { createHash, randomInt } from 'node:crypto';
import { iso } from './queries';
import type { Sql } from './sql';

// Closed-alpha invite codes (DECISIONS Phase 6). Only the SHA-256 of a code is stored. Codes are redeemed
// atomically in the account-creation transaction, so concurrent sign-ups can never exceed `max_uses`.

/** No 0/O, 1/I/L or U: easy to read aloud and type on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export function newInviteCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
export const normalizeInvite = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashInvite = (code: string): Buffer =>
  createHash('sha256').update(normalizeInvite(code)).digest();

export interface InviteRow {
  inviteId: number;
  label: string;
  maxUses: number;
  uses: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Create an invite. The code is returned once and never stored. */
export async function createInvite(
  sql: Sql,
  o: { label: string; maxUses: number; expiresAt?: number | null; now: number },
): Promise<{ code: string; inviteId: number }> {
  const code = newInviteCode();
  const [r] = await sql.query<{ invite_id: number }>(
    `insert into identity.invites (code_hash, label, max_uses, created_at, expires_at)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz) returning invite_id`,
    [hashInvite(code), o.label, o.maxUses, iso(o.now), o.expiresAt ? iso(o.expiresAt) : null],
  );
  return { code, inviteId: Number(r!.invite_id) };
}

const ms = (v: unknown): number | null =>
  v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))).getTime();

export async function listInvites(sql: Sql): Promise<InviteRow[]> {
  const rows = await sql.query<Record<string, unknown>>('select * from identity.invites order by invite_id');
  return rows.map((r) => ({
    inviteId: Number(r.invite_id),
    label: r.label as string,
    maxUses: r.max_uses as number,
    uses: r.uses as number,
    createdAt: ms(r.created_at)!,
    expiresAt: ms(r.expires_at),
    revokedAt: ms(r.revoked_at),
  }));
}

export async function revokeInvite(sql: Sql, inviteId: number, now: number): Promise<boolean> {
  const rows = await sql.query(
    `update identity.invites set revoked_at = $2::timestamptz where invite_id = $1 and revoked_at is null
     returning invite_id`,
    [inviteId, iso(now)],
  );
  return rows.length === 1;
}

const USABLE = `revoked_at is null and uses < max_uses and (expires_at is null or expires_at > $2::timestamptz)`;

/** Whether a code could be redeemed now (checked before the passkey ceremony; nothing is consumed). */
export async function inviteUsable(sql: Sql, code: string, now: number): Promise<boolean> {
  const rows = await sql.query(`select 1 from identity.invites where code_hash = $1 and ${USABLE}`, [
    hashInvite(code),
    iso(now),
  ]);
  return rows.length === 1;
}

/** Consume one use, atomically. Returns the invite id, or null if the code can't be used. */
export async function redeemInvite(tx: Sql, code: string, now: number): Promise<number | null> {
  const [r] = await tx.query<{ invite_id: number }>(
    `update identity.invites set uses = uses + 1 where code_hash = $1 and ${USABLE} returning invite_id`,
    [hashInvite(code), iso(now)],
  );
  return r ? Number(r.invite_id) : null;
}
