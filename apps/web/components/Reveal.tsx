'use client';

import Link from 'next/link';
import type { MatchRevealResponse, RevealView, SeatId } from '@canutell/protocol';
import { FunSurvey } from './FunSurvey';
import { seatName } from './Match';

// SPEC §Reveal: every seat's role and agent version, each player's ballot accuracy, final scores and key
// moments. Used live at the end of a match and when reopening one at /match/[id] (built from the database).

export interface RevealProps {
  matchId: string;
  seat: SeatId;
  reveal: RevealView;
  myStakes: MatchRevealResponse['myStakes'];
  onDone?: () => void;
}

export function Reveal({ matchId, seat, reveal: r, myStakes, onDone }: RevealProps) {
  const role = (s: number) => (r.seats[s]!.isAgent ? 'AI' : 'human');
  // SPEC §Scoring: agents are ranked separately and never appear on human leaderboards.
  const humans = r.seats.filter((s) => !s.isAgent).sort((a, b) => b.finalScore - a.finalScore);
  const agents = r.seats.filter((s) => s.isAgent);
  const myBallot = r.ballots[seat]!;
  // One order everywhere (live and reopened): by round, then stake id.
  const stakes = [...myStakes].sort((a, b) => a.round - b.round || a.stakeId.localeCompare(b.stakeId));
  const me = r.seats[seat]!;

  return (
    <>
      <section className="card">
        <h2>Reveal</h2>
        <p>
          You were <strong>{seatName(seat)}</strong> ({me.isAgent ? 'AI' : 'human'}).{' '}
          {agents.length === 0
            ? 'There were no AI players at this table.'
            : `AI players: ${agents.map((a) => seatName(a.seatId)).join(', ')}.`}
        </p>
        <h3>Leaderboard</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Score</th>
              <th>Ballot</th>
            </tr>
          </thead>
          <tbody>
            {humans.map((s, i) => (
              <tr key={s.seatId} className={s.seatId === seat ? 'me' : ''}>
                <td>{i + 1}</td>
                <td>
                  {seatName(s.seatId)}
                  {s.seatId === seat && ' (you)'}
                  {s.exiledRound !== null && <span className="tag">exiled r{s.exiledRound}</span>}
                </td>
                <td>
                  <strong>{s.finalScore}</strong>
                  <div className="muted small">
                    {s.coinsBeforeReveal} coins + {s.delayPaid} delayed + {s.exileBonus} exile +{' '}
                    {s.ballotPayoff} ballot
                  </div>
                </td>
                <td>
                  {s.ballotAccuracy.correct}/{s.ballotAccuracy.labeled} right
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {agents.length > 0 && (
          <>
            <h3>AI players (ranked separately)</h3>
            <ul className="plain">
              {agents.map((a) => (
                <li key={a.seatId}>
                  {seatName(a.seatId)} — {a.agentVersion}, {a.finalScore} coins
                  {a.exiledRound !== null && <span className="tag">exiled r{a.exiledRound}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h3>Your ballot</h3>
        {myBallot.timedOut && (
          <p className="muted">You did not submit a ballot (all labels blank, 0 points).</p>
        )}
        <table>
          <thead>
            <tr>
              <th>Seat</th>
              <th>You said</th>
              <th>Was</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {r.seats
              .filter((s) => s.seatId !== seat)
              .map((s) => {
                const l = myBallot.labels.find((x) => x.target === s.seatId);
                const right = l && (l.label === 'agent') === s.isAgent;
                return (
                  <tr key={s.seatId}>
                    <td>{seatName(s.seatId)}</td>
                    <td>{l ? `${l.label} (${l.confidence}%)` : <span className="muted">blank</span>}</td>
                    <td>
                      {role(s.seatId)} {l && (right ? '✓' : '✗')}
                    </td>
                    <td>
                      {l ? (l.applied ? (l.payoff > 0 ? `+${l.payoff}` : l.payoff) : `(${l.payoff})`) : 0}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </section>

      {r.votes.length > 0 && (
        <section className="card">
          <h3>Votes</h3>
          {r.votes.map((v) => (
            <div key={v.round} className="vote-round">
              <strong>Round {v.round}</strong>:{' '}
              {v.exiled === null ? 'no one exiled' : `${seatName(v.exiled)} exiled (${role(v.exiled)})`}
              <div className="muted small">
                {v.ballots
                  .map((b) =>
                    b.target === null
                      ? `${seatName(b.voter)} ${b.timedOut ? 'did not vote' : 'skipped'}`
                      : `${seatName(b.voter)} → ${seatName(b.target)}`,
                  )
                  .join(' · ')}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h3>Your stakes</h3>
        {stakes.length === 0 ? (
          <p className="muted">No stakes sent or received.</p>
        ) : (
          <ul className="plain">
            {stakes.map((s) => (
              <li key={s.stakeId}>
                Round {s.round}:{' '}
                {s.from === seat
                  ? `you sent ${s.sent} to ${seatName(s.to)} (${role(s.to)}) → got back ${s.returned ?? 0}`
                  : `${seatName(s.from)} (${role(s.from)}) sent you ${s.sent}, ${s.received} arrived → you returned ${s.returned ?? 0}`}
              </li>
            ))}
          </ul>
        )}
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
        <div className="row wrap">
          {onDone && <button onClick={onDone}>Back to lobby</button>}
          <Link className="link" href={`/match/${matchId}`}>
            Permanent link to this reveal
          </Link>
        </div>
      </section>
      <FunSurvey matchId={matchId} />
    </>
  );
}
