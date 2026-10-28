'use client';

import { Lobby } from '@/components/Lobby';
import { Match } from '@/components/Match';
import { useGame } from '@/lib/useGame';

export default function Home() {
  const game = useGame();
  const { state } = game;
  return (
    <main>
      <h1>CANUTELL</h1>
      {!state.connected && <p className="notice">Connecting to the game server…</p>}
      {state.match ? <Match game={game} /> : <Lobby game={game} />}
    </main>
  );
}
