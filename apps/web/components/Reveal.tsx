'use client';

import type { SeatView } from '@canutell/protocol';
import { seatName } from './Match';

export function Reveal({ view, onDone }: { view: SeatView; onDone: () => void }) {
  const r = view.reveal;
  if (!r) return null;
  const ranked = [...r.seats].sort((a, b) => b.finalScore - a.finalScore);
  return (
    <>
      <section className="card">
        <h2>Reveal</h2>
        <table>
          <thead>
            <tr>
              <th>Seat</th>
              <th>Was</th>
              <th>Score</th>
              <th>Ballot</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((s) => (
              <tr key={s.seatId} className={s.seatId === view.seat ? 'me' : ''}>
                <td>
                  {seatName(s.seatId)}
                  {s.seatId === view.seat && ' (you)'}
                  {s.exiledRound !== null && <span className="tag">exiled r{s.exiledRound}</span>}
                </td>
                <td>{s.isAgent ? `AI (${s.agentVersion})` : 'human'}</td>
                <td
                  title={`coins ${s.coinsBeforeReveal} + delayed ${s.delayPaid} + exile bonus ${s.exileBonus} + ballot ${s.ballotPayoff}`}
                >
                  <strong>{s.finalScore}</strong>
                  <div className="muted small">
                    {s.coinsBeforeReveal} + {s.delayPaid} + {s.exileBonus} + {s.ballotPayoff}
                  </div>
                </td>
                <td>
                  {s.ballotAccuracy.correct}/{s.ballotAccuracy.labeled} right
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Score = coins + delayed payouts + exile bonus + ballot payoff. AI players are ranked separately.
        </p>
      </section>
      <section className="card">
        <h3>Key moments</h3>
        <ul className="plain">
          {r.keyMoments.biggestStake && (
            <li>
              Biggest stake: {seatName(r.keyMoments.biggestStake.from)} →{' '}
              {seatName(r.keyMoments.biggestStake.to)}, {r.keyMoments.biggestStake.sent} coins (returned{' '}
              {r.keyMoments.biggestStake.returned})
            </li>
          )}
          <li>Unreturned stakes: {r.keyMoments.unreturnedStakes.length}</li>
          {r.keyMoments.exiles.map((e) => (
            <li key={e.round}>
              Round {e.round}: {seatName(e.seat)} exiled — {e.isAgent ? 'an AI' : 'a human'}
            </li>
          ))}
        </ul>
        <button onClick={onDone}>Back to lobby</button>
      </section>
    </>
  );
}
