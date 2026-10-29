'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AI_DISCLOSURE, LONG_WAIT_HINT_MS, type GameNights, type Mode } from '@canutell/protocol';
import type { useGame } from '@/lib/useGame';

type Game = ReturnType<typeof useGame>;

/**
 * The next game night, in the player's own time zone (DECISIONS Phase 6). The schedule is the same for
 * everyone; nothing here depends on who is queued (CLAUDE.md invariant 7).
 */
function GameNightBanner({ nights }: { nights: GameNights | null }) {
  const now = Date.now();
  const next = nights?.windows.find((w) => w.end > now);
  if (!next) return null;
  const fmt = (t: number) =>
    new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <p className="notice" data-testid="game-night">
      {next.start <= now
        ? `Game night is on now, until ${new Date(next.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Matches fill fastest now.`
        : `Next game night: ${fmt(next.start)}. Matches fill fastest then.`}
    </p>
  );
}

/** A fixed timer on this player's own wait — never a count of who else is waiting. */
function useLongWait(searching: boolean): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!searching) return;
    const t = setTimeout(() => setLong(true), LONG_WAIT_HINT_MS);
    return () => clearTimeout(t);
  }, [searching]);
  return long;
}

export function Lobby({ game }: { game: Game }) {
  const { state } = game;
  const [code, setCode] = useState('');
  const longWait = useLongWait(state.queue !== null);

  if (state.accountRequired) {
    return (
      <section className="card">
        <h2>Closed alpha</h2>
        <p>CANUTELL is in a closed alpha for invited players.</p>
        <GameNightBanner nights={state.gameNights} />
        <div className="row">
          <Link className="button" href="/signin">
            Sign in
          </Link>
          <Link className="button secondary" href="/signup">
            I have an invite
          </Link>
        </div>
      </section>
    );
  }

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
        {longWait && (
          <p className="muted" data-testid="long-wait">
            Few players are online right now — matches fill best during game nights.
          </p>
        )}
        <GameNightBanner nights={state.gameNights} />
        <p className="disclosure">{state.queue.disclosure}</p>
        <button className="secondary" onClick={game.leaveQueue}>
          Cancel
        </button>
      </section>
    );
  }

  // Only the player's own account status is ever shown; seats never show anyone's (CLAUDE.md invariant 7).
  const accountBar = state.account ? (
    <p className="account-bar">
      <span>
        Signed in · <strong>{state.account.trustLevel}</strong>
      </span>
      <Link href="/account">Account</Link>
    </p>
  ) : (
    <p className="account-bar">
      <span className="muted">Playing as a guest.</span>
      <Link href="/signup">Create account</Link>
      <span className="muted">·</span>
      <Link href="/signin">Sign in</Link>
    </p>
  );

  const modes: { mode: Mode; label: string; detail: string }[] = [
    { mode: 'quick', label: 'Quick', detail: '3 rounds · about 7 min' },
    { mode: 'full', label: 'Full', detail: '5 rounds · about 11½ min' },
  ];
  return (
    <section className="card">
      {accountBar}
      <GameNightBanner nights={state.gameNights} />
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
