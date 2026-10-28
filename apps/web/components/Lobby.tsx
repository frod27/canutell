'use client';

import { useState } from 'react';
import { AI_DISCLOSURE, type Mode } from '@canutell/protocol';
import type { useGame } from '@/lib/useGame';

type Game = ReturnType<typeof useGame>;

export function Lobby({ game }: { game: Game }) {
  const { state } = game;
  const [code, setCode] = useState('');

  if (state.party) {
    const p = state.party;
    return (
      <section className="card">
        <h2>Party {p.code}</h2>
        <p>
          {p.members} of 6 players · {p.mode} mode
        </p>
        <p className="muted">
          Share the code. A party needs at least 4 players; open seats are filled by AI.
        </p>
        <p className="disclosure">{p.disclosure}</p>
        <div className="row">
          {p.isHost && (
            <button disabled={!p.canStart} onClick={game.startParty}>
              Start
            </button>
          )}
          <button className="secondary" onClick={game.leaveParty}>
            Leave party
          </button>
        </div>
      </section>
    );
  }

  if (state.queue) {
    return (
      <section className="card">
        <h2>Finding a match…</h2>
        <p>{state.queue.mode} mode</p>
        <p className="disclosure">{state.queue.disclosure}</p>
        <button className="secondary" onClick={game.leaveQueue}>
          Cancel
        </button>
      </section>
    );
  }

  const modes: { mode: Mode; label: string; detail: string }[] = [
    { mode: 'quick', label: 'Quick', detail: '3 rounds · about 7 min' },
    { mode: 'full', label: 'Full', detail: '5 rounds · about 11½ min' },
  ];
  return (
    <section className="card">
      <h2>Play</h2>
      <p className="disclosure">{AI_DISCLOSURE}</p>
      <div className="stack">
        {modes.map((m) => (
          <button key={m.mode} onClick={() => game.joinQueue(m.mode)}>
            {m.label} <span className="muted">— {m.detail}</span>
          </button>
        ))}
      </div>
      <h3>Play with friends</h3>
      <div className="row">
        <button className="secondary" onClick={() => game.createParty('quick')}>
          New quick party
        </button>
        <button className="secondary" onClick={() => game.createParty('full')}>
          New full party
        </button>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length === 6) game.joinParty(code.trim());
        }}
      >
        <input
          aria-label="Party code"
          placeholder="Party code"
          value={code}
          maxLength={6}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button type="submit" className="secondary">
          Join
        </button>
      </form>
      {state.partyClosed && <p className="muted">Party closed: {state.partyClosed}</p>}
    </section>
  );
}
