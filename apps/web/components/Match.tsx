'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatChannel, Prompt, SeatId, SeatView } from '@canutell/protocol';
import type { useGame } from '@/lib/useGame';
import { Reveal } from './Reveal';

type Game = ReturnType<typeof useGame>;
type Act = Game['act'];

export const seatName = (s: number) => `Seat ${s + 1}`;

const PHASE_LABEL: Record<string, string> = {
  invest: 'Invest',
  deal: 'Deal',
  gamble: 'Gamble',
  vote: 'Vote',
  final_ballot: 'Final ballot',
  reveal: 'Reveal',
  lobby: 'Starting',
};

function useCountdown(deadline: number | null, offset: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - (now + offset)) / 1000));
}

export function Match({ game }: { game: Game }) {
  const view = game.state.view;
  const secs = useCountdown(view?.deadline ?? null, game.state.clockOffset);
  if (!view) return <section className="card">Joining match…</section>;
  if (view.phase === 'reveal' && view.reveal) {
    const myStakes = [
      ...view.stakesSent.map((s) => ({ ...s, from: view.seat })),
      ...view.stakesReceived.map((s) => ({ ...s, to: view.seat })),
    ].map((s) => ({
      stakeId: s.stakeId,
      round: s.round,
      from: s.from,
      to: s.to,
      sent: s.sent,
      received: s.received,
      returned: s.returned,
    }));
    return (
      <Reveal
        matchId={view.matchId}
        seat={view.seat}
        reveal={view.reveal}
        myStakes={myStakes}
        onDone={game.leaveMatch}
      />
    );
  }
  const exiled = view.self.exiledRound !== null;

  return (
    <>
      <header className="card status">
        <div>
          <strong>{seatName(view.seat)}</strong> {exiled && <span className="tag">exiled</span>}
        </div>
        <div>
          Round {view.round}/{view.totalRounds} · {PHASE_LABEL[view.phase]}
        </div>
        <div className="big">{secs ?? '–'}s</div>
        <div>
          <strong>{view.self.balance}</strong> coins
        </div>
      </header>
      {game.state.notice && <p className="notice">{game.state.notice}</p>}
      <section className="card">
        {view.prompts.length === 0 ? (
          <p className="muted">
            {exiled
              ? 'You are exiled: you can still return stakes and fill your ballot.'
              : 'Waiting for the next phase…'}
          </p>
        ) : (
          view.prompts.map((p) => (
            <PromptForm
              key={p.kind === 'return' ? p.stakeId : p.kind}
              prompt={p}
              view={view}
              act={game.act}
            />
          ))
        )}
      </section>
      <Chat view={view} act={game.act} />
      <History view={view} />
    </>
  );
}

function PromptForm({ prompt, view, act }: { prompt: Prompt; view: SeatView; act: Act }) {
  const seat = view.seat;
  switch (prompt.kind) {
    case 'invest':
      return (
        <Amount
          title={`Invest 0–${prompt.max} coins into the pot`}
          min={0}
          max={prompt.max}
          submit="Invest"
          onSubmit={(amount) => act({ type: 'invest', seat, amount })}
        />
      );
    case 'stake':
      return <Stake prompt={prompt} seat={seat} act={act} />;
    case 'return':
      return (
        <Amount
          title={`${seatName(prompt.from)} staked with you: ${prompt.received} coins arrived. Return 0–${prompt.max} (open until round ${prompt.deadlineRound} Deal ends).`}
          min={0}
          max={prompt.max}
          submit="Return"
          onSubmit={(amount) => act({ type: 'return', seat, stakeId: prompt.stakeId, amount })}
        />
      );
    case 'gamble':
      return (
        <div>
          <h3>Gamble ({prompt.menu})</h3>
          <div className="stack">
            {(['A', 'B', 'C'] as const).map((o) => (
              <button key={o} onClick={() => act({ type: 'gamble', seat, option: o })}>
                {o}: {describeOption(prompt.options[o])}
              </button>
            ))}
          </div>
        </div>
      );
    case 'vote':
      return (
        <div>
          <h3>Vote to exile</h3>
          <p className="muted">Exiled with 3+ votes and strictly more than anyone else.</p>
          <div className="row wrap">
            {prompt.targets.map((t) => (
              <button key={t} onClick={() => act({ type: 'vote', seat, target: t })}>
                {seatName(t)}
              </button>
            ))}
            <button className="secondary" onClick={() => act({ type: 'vote', seat, target: null })}>
              Skip
            </button>
          </div>
        </div>
      );
    case 'ballot':
      return <Ballot targets={prompt.targets} seat={seat} act={act} />;
  }
}

function describeOption(o: Extract<Prompt, { kind: 'gamble' }>['options']['A']): string {
  switch (o.kind) {
    case 'sure':
      return `+${o.amount} for sure`;
    case 'chance':
      return `${o.percent}% chance of +${o.amount}`;
    case 'now':
      return `+${o.amount} now`;
    case 'at_end':
      return `+${o.amount} at match end`;
    case 'at_end_if_not_exiled':
      return `+${o.amount} at match end, only if not exiled`;
  }
}

function Amount(p: {
  title: string;
  min: number;
  max: number;
  submit: string;
  onSubmit: (n: number) => void;
}) {
  const [n, setN] = useState(p.min);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit(Math.max(p.min, Math.min(p.max, Math.round(n))));
      }}
    >
      <h3>{p.title}</h3>
      <div className="row">
        <input
          type="range"
          min={p.min}
          max={p.max}
          value={n}
          onChange={(e) => setN(Number(e.target.value))}
        />
        <input
          type="number"
          min={p.min}
          max={p.max}
          value={n}
          onChange={(e) => setN(Number(e.target.value))}
          className="num"
        />
        <button type="submit">{p.submit}</button>
      </div>
    </form>
  );
}

function Stake({
  prompt,
  seat,
  act,
}: {
  prompt: Extract<Prompt, { kind: 'stake' }>;
  seat: SeatId;
  act: Act;
}) {
  const [to, setTo] = useState<SeatId | null>(prompt.targets[0] ?? null);
  const [amount, setAmount] = useState(Math.min(10, prompt.max));
  const canStake = prompt.max >= prompt.min && to !== null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canStake)
          act({ type: 'stake', seat, to, amount: Math.max(prompt.min, Math.min(prompt.max, amount)) });
      }}
    >
      <h3>Stake (doubles on arrival; they choose what to return)</h3>
      <div className="row wrap">
        <select value={to ?? ''} onChange={(e) => setTo(Number(e.target.value) as SeatId)}>
          {prompt.targets.map((t) => (
            <option key={t} value={t}>
              {seatName(t)}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={prompt.min}
          max={prompt.max}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="num"
        />
        <button type="submit" disabled={!canStake}>
          Send
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => act({ type: 'stake', seat, to: null, amount: 0 })}
        >
          No stake this round
        </button>
      </div>
    </form>
  );
}

function Ballot({ targets, seat, act }: { targets: SeatId[]; seat: SeatId; act: Act }) {
  const [rows, setRows] = useState(() =>
    targets.map((t) => ({ target: t, include: true, label: 'human' as 'human' | 'agent', confidence: 50 })),
  );
  const update = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        act({
          type: 'ballot',
          seat,
          labels: rows
            .filter((r) => r.include)
            .map(({ target, label, confidence }) => ({ target, label, confidence })),
        });
      }}
    >
      <h3>Final ballot: who is an AI?</h3>
      <p className="muted">+30 if certain and right, −10 if certain and wrong, +20 at 50%. Blank scores 0.</p>
      {rows.map((r, i) => (
        <div key={r.target} className="ballot-row">
          <label>
            <input
              type="checkbox"
              checked={r.include}
              onChange={(e) => update(i, { include: e.target.checked })}
            />{' '}
            {seatName(r.target)}
          </label>
          <select
            value={r.label}
            disabled={!r.include}
            onChange={(e) => update(i, { label: e.target.value as 'human' | 'agent' })}
          >
            <option value="human">human</option>
            <option value="agent">agent</option>
          </select>
          <input
            type="range"
            min={50}
            max={100}
            value={r.confidence}
            disabled={!r.include}
            onChange={(e) => update(i, { confidence: Number(e.target.value) })}
          />
          <span className="num">{r.confidence}%</span>
        </div>
      ))}
      <button type="submit">Submit ballot</button>
    </form>
  );
}

function Chat({ view, act }: { view: SeatView; act: Act }) {
  const channels = view.chat.channels;
  const [channel, setChannel] = useState<ChatChannel>(channels[0] ?? 'table');
  const [to, setTo] = useState<SeatId | null>(view.chat.dmTargets[0] ?? null);
  const [text, setText] = useState('');
  const typingStart = useRef<number | null>(null);
  const pasted = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!channels.includes(channel) && channels[0]) setChannel(channels[0]);
  }, [channels, channel]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [view.chat.messages.length]);
  if (channels.length === 0) return null;

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    act({
      type: 'chat',
      seat: view.seat,
      channel,
      to: channel === 'dm' ? to : null,
      text: t,
      client: {
        typingMs: typingStart.current === null ? null : Date.now() - typingStart.current,
        pasted: pasted.current,
        clientSentAt: Date.now(),
      },
    });
    setText('');
    typingStart.current = null;
    pasted.current = false;
  };

  return (
    <section className="card">
      <h3>Chat</h3>
      <div className="chat" ref={list}>
        {view.chat.messages.map((m, i) => (
          <div key={i} className={`msg ${m.channel}`}>
            <span className="who">
              {m.from === view.seat ? 'You' : seatName(m.from)}
              {m.channel === 'dm' && ` → ${m.to === view.seat ? 'you' : seatName(m.to!)}`}
              {m.channel === 'exile' && ' (exile)'}
            </span>{' '}
            {m.text}
          </div>
        ))}
      </div>
      <form className="row wrap" onSubmit={send}>
        <select value={channel} onChange={(e) => setChannel(e.target.value as ChatChannel)}>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c === 'table' ? 'Everyone' : c === 'dm' ? 'Private' : 'Exile channel'}
            </option>
          ))}
        </select>
        {channel === 'dm' && (
          <select value={to ?? ''} onChange={(e) => setTo(Number(e.target.value) as SeatId)}>
            {view.chat.dmTargets.map((t) => (
              <option key={t} value={t}>
                {seatName(t)}
              </option>
            ))}
          </select>
        )}
        <input
          className="grow"
          value={text}
          maxLength={500}
          placeholder="Say something"
          onChange={(e) => {
            if (typingStart.current === null) typingStart.current = Date.now();
            setText(e.target.value);
          }}
          onPaste={() => (pasted.current = true)}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}

function History({ view }: { view: SeatView }) {
  return (
    <section className="card">
      <h3>Table</h3>
      <ul className="plain">
        {view.seats.map((s) => (
          <li key={s.seatId}>
            {seatName(s.seatId)}
            {s.seatId === view.seat && ' (you)'}
            {s.exiledRound !== null && <span className="tag">exiled in round {s.exiledRound}</span>}
          </li>
        ))}
      </ul>
      {view.investResults.length > 0 && <h3>Pot results</h3>}
      <ul className="plain">
        {view.investResults.map((r) => (
          <li key={r.round}>
            Round {r.round}: pot {r.pot} → {r.share} each
            {r.contributions &&
              ` (${r.contributions.map((c) => `${seatName(c.seat)}: ${c.amount}`).join(', ')})`}
          </li>
        ))}
      </ul>
      {(view.stakesSent.length > 0 || view.stakesReceived.length > 0) && <h3>Your stakes</h3>}
      <ul className="plain">
        {view.stakesSent.map((s) => (
          <li key={s.stakeId}>
            Round {s.round}: you sent {s.sent} to {seatName(s.to)} → returned {s.returned ?? 'pending'}
          </li>
        ))}
        {view.stakesReceived.map((s) => (
          <li key={s.stakeId}>
            Round {s.round}: {seatName(s.from)} sent you {s.sent} ({s.received} arrived) → you returned{' '}
            {s.returned ?? 'pending'}
          </li>
        ))}
      </ul>
      {view.myGambles.length > 0 && <h3>Your gambles</h3>}
      <ul className="plain">
        {view.myGambles.map((g) => (
          <li key={g.round}>
            Round {g.round}: option {g.option} → {g.immediate === null ? 'pending' : `+${g.immediate} now`}
          </li>
        ))}
        {view.myDelays.map((d) => (
          <li key={`d${d.round}`}>
            Round {d.round}: +{d.amount} at match end ({d.status})
          </li>
        ))}
      </ul>
      {view.voteResults.length > 0 && <h3>Votes</h3>}
      <ul className="plain">
        {view.voteResults.map((v) => (
          <li key={v.round}>
            Round {v.round}: {v.exiled === null ? 'no one exiled' : `${seatName(v.exiled)} exiled`}
          </li>
        ))}
      </ul>
    </section>
  );
}
