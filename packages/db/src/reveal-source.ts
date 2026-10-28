import type { MatchRevealResponse, Mode } from '@canutell/protocol';
import { revealFromDb, seatOfPlayer, stakesForSeat } from './queries';
import type { Sql } from './sql';

/** Where the server's reveal endpoint gets its answers. */
export interface RevealSource {
  /** The reveal for `playerId`'s seat in `matchId`, or null if they had no seat or it is not finished. */
  reveal(matchId: string, playerId: string): Promise<MatchRevealResponse | null>;
}

export function dbRevealSource(sql: Sql): RevealSource {
  return {
    async reveal(matchId, playerId) {
      const seat = await seatOfPlayer(sql, matchId, playerId);
      if (seat === null) return null;
      const reveal = await revealFromDb(sql, matchId);
      if (!reveal) return null;
      const [m] = await sql.query<{ mode: Mode }>('select mode from matches where match_id = $1', [matchId]);
      return { matchId, mode: m!.mode, seat, reveal, myStakes: await stakesForSeat(sql, matchId, seat) };
    },
  };
}
