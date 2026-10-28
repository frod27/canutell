'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ServerMessageSchema,
  type Action,
  type ClientMessage,
  type Mode,
  type ServerMessage,
  type SeatView,
} from '@canutell/protocol';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export interface GameState {
  connected: boolean;
  playerId: string | null;
  queue: Msg<'queue.status'> | null;
  party: Msg<'party.state'> | null;
  partyClosed: string | null;
  match: Msg<'match.found'> | null;
  view: SeatView | null;
  /** serverTime − Date.now() at the last frame, to show countdowns in server time. */
  clockOffset: number;
  notice: string | null;
}

const TOKEN_KEY = 'canutell.token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: the session simply won't survive a reload */
  }
}

export function serverUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SERVER_URL;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:8787`;
}

/** Client telemetry for chat (stored by the server, never trusted). */
export interface ChatTelemetry {
  typingMs: number | null;
  pasted: boolean;
}

export function useGame() {
  const [state, setState] = useState<GameState>({
    connected: false,
    playerId: null,
    queue: null,
    party: null,
    partyClosed: null,
    match: null,
    view: null,
    clockOffset: 0,
    notice: null,
  });
  const ws = useRef<WebSocket | null>(null);
  const viewRef = useRef<SeatView | null>(null);
  const actionSeq = useRef(0);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const socket = new WebSocket(serverUrl());
      ws.current = socket;
      socket.onopen = () => {
        setState((s) => ({ ...s, connected: true, notice: null }));
        socket.send(JSON.stringify({ type: 'hello', token: readToken() } satisfies ClientMessage));
      };
      socket.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!stopped) retry = setTimeout(connect, 1500);
      };
      socket.onmessage = (ev) => {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(String(ev.data)));
        if (!parsed.success) return;
        const m = parsed.data;
        setState((s) => reduce(s, m));
        if (m.type === 'welcome') writeToken(m.token);
        if (m.type === 'view') viewRef.current = m.view;
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  }, []);

  const act = useCallback(
    (action: Action) => {
      const view = viewRef.current;
      const matchId = view?.matchId;
      if (!matchId || !view) return;
      send({
        type: 'action',
        matchId,
        clientActionId: `c${++actionSeq.current}`,
        action,
        seenPhase: { round: view.round, phase: view.phase },
        clientSentAt: Date.now(),
      });
    },
    [send],
  );

  return {
    state,
    joinQueue: (mode: Mode) => send({ type: 'queue.join', mode }),
    leaveQueue: () => send({ type: 'queue.leave' }),
    createParty: (mode: Mode) => send({ type: 'party.create', mode }),
    joinParty: (code: string) => send({ type: 'party.join', code: code.toUpperCase() }),
    leaveParty: () => send({ type: 'party.leave' }),
    startParty: () => send({ type: 'party.start' }),
    act,
    leaveMatch: () => setState((s) => ({ ...s, match: null, view: null })),
  };
}

function reduce(s: GameState, m: ServerMessage): GameState {
  switch (m.type) {
    case 'welcome':
      return { ...s, playerId: m.playerId, clockOffset: m.serverTime - Date.now() };
    case 'queue.status':
      return { ...s, queue: m.state === 'idle' ? null : m };
    case 'party.state':
      return { ...s, party: m, partyClosed: null };
    case 'party.closed':
      return { ...s, party: null, partyClosed: m.reason };
    case 'match.found':
      return { ...s, match: m, queue: null, party: null, view: null };
    case 'view':
      return { ...s, view: m.view, clockOffset: m.serverTime - Date.now() };
    case 'action.rejected':
      return {
        ...s,
        notice: m.code === 'late' ? 'Too late — that phase already ended.' : `Rejected: ${m.message}`,
      };
    case 'error':
      return { ...s, notice: m.message };
    default:
      return s;
  }
}
