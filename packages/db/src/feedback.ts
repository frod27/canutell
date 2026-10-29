import { maskChat } from '@canutell/engine';
import type { FeedbackRequest } from '@canutell/protocol';
import { AccountError } from './accounts';
import { iso, seatOfPlayer } from './queries';
import type { Sql } from './sql';

// The post-match survey (DECISIONS Phase 6): "How much fun was this match?". Product data only: it is
// never in the training views and never exported. The comment is masked like chat (SPEC §Consent and
// privacy). One answer per seat, final.

export async function submitFeedback(
  sql: Sql,
  f: FeedbackRequest & { matchId: string; playerId: string; now: number },
): Promise<void> {
  const seat = await seatOfPlayer(sql, f.matchId, f.playerId);
  if (seat === null) throw new AccountError('not_found', 'not a seat of this match');
  const [m] = await sql.query<{ status: string }>('select status from matches where match_id = $1', [
    f.matchId,
  ]);
  if (m?.status !== 'completed') throw new AccountError('not_completed', 'the match has not finished');
  const comment = f.comment === null ? null : maskChat(f.comment.trim()).text || null;
  try {
    await sql.query(
      `insert into match_feedback (match_id, seat_id, fun, tags, comment, submitted_at)
       values ($1, $2, $3, $4::text[], $5, $6::timestamptz)`,
      [f.matchId, seat, f.fun, f.tags, comment, iso(f.now)],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AccountError('already_answered', 'already answered');
    throw e;
  }
}
