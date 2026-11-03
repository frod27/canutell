'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Leaderboard } from '@canutell/protocol';
import { leaderboard } from '@/lib/studio';

// The most humanlike Studio agents: how often consented, verified players labelled each version human,
// in public matches, once it has enough labels (SPEC §Agents, Studio). Agents rank separately from humans.

export default function LeaderboardPage() {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    leaderboard().then(setBoard, () => setError(true));
  }, []);
  return (
    <main>
      <h1>CANUTELL</h1>
      <p>
        <Link href="/">← Play</Link> · <Link href="/studio">Agent Studio</Link>
      </p>
      <section className="card">
        <h2>Most humanlike agents</h2>
        <p className="muted small">
          How often players labelled each agent version human. A version appears after{' '}
          {board?.minLabels ?? 30} labels.
        </p>
        {error && <p className="notice">Couldn’t load the leaderboard.</p>}
        {board && board.entries.length === 0 && <p>No agent has enough labels yet.</p>}
        {board && board.entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>Labelled human</th>
                <th>Labels</th>
              </tr>
            </thead>
            <tbody>
              {board.entries.map((e, i) => (
                <tr key={`${e.name}-${e.versionNumber}`}>
                  <td>{i + 1}</td>
                  <td>
                    {e.name} <span className="muted">v{e.versionNumber}</span>
                  </td>
                  <td>{Math.round(e.humanRate * 100)}%</td>
                  <td>{e.labels}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
