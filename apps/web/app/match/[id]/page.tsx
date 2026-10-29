'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MatchRevealResponseSchema, type MatchRevealResponse } from '@canutell/protocol';
import { Reveal } from '@/components/Reveal';
import { readSession } from '@/lib/account';
import { readToken, serverHttpUrl } from '@/lib/useGame';

type Load =
  { state: 'loading' } | { state: 'ok'; data: MatchRevealResponse } | { state: 'error'; message: string };

/** Reopen a finished match's reveal. Only players who held a seat in it can see it. */
export default function MatchRevealPage() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    // Signed in: any device. As a guest: only the device that played, until the server restarts.
    const token = readSession() ?? readToken();
    if (!token) {
      setLoad({
        state: 'error',
        message:
          'This reveal is only visible to players from that match: signed in, or as a guest on the device they played on.',
      });
      return;
    }
    fetch(`${serverHttpUrl()}/api/matches/${encodeURIComponent(id)}/reveal`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (res.status === 404 || res.status === 401)
          throw new Error(
            'Reveal not found. It is only visible to players from that match: signed in, or as a guest on the device they played on.',
          );
        if (res.status === 501)
          throw new Error('This server is not storing matches in a database, so reveals cannot be reopened.');
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const parsed = MatchRevealResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('Unexpected response from the server.');
        setLoad({ state: 'ok', data: parsed.data });
      })
      .catch((e: Error) => setLoad({ state: 'error', message: e.message }));
  }, [id]);

  return (
    <main>
      <h1>
        <Link href="/" className="plainlink">
          CANUTELL
        </Link>
      </h1>
      {load.state === 'loading' && <p className="muted">Loading reveal…</p>}
      {load.state === 'error' && <p className="notice">{load.message}</p>}
      {load.state === 'ok' && (
        <Reveal
          matchId={load.data.matchId}
          seat={load.data.seat}
          reveal={load.data.reveal}
          myStakes={load.data.myStakes}
        />
      )}
    </main>
  );
}
