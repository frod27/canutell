'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ServerMessageSchema,
  type AccountSummary,
  type Action,
  type ClientEnv,
  type ClientMessage,
  type Mode,
  type ServerMessage,
  type SeatView,
} from '@canutell/protocol';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export interface GameState {
  connected: boolean;
  playerId: string | null;
  /** This player's own account when signed in; null for guests. */
  account: AccountSummary | null;
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

export function readToken(): string | null {
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

/** Session tokens are kept by lib/account.ts; read here to say hello as the account. */
function readSessionToken(): string | null {
  try {
    return localStorage.getItem('canutell.session');
  } catch {
    return null;
  }
}
function clearSessionToken(): void {
  try {
    localStorage.removeItem('canutell.session');
  } catch {
    /* nothing to clear */
  }
}

/**
 * Headless-browser indicators, reduced to booleans (SPEC §Integrity). No fingerprint, no user-agent string.
 * The server keeps them only for account holders' seats.
 */
function clientEnv(): ClientEnv {
  return {
    webdriver: navigator.webdriver === true,
    headlessUserAgent: /HeadlessChrome/i.test(navigator.userAgent),
    noLanguages: !navigator.languages || navigator.languages.length === 0,
    zeroOuterSize: window.outerWidth === 0 && window.outerHeight === 0,
  };
}

/** HTTP base of the game server (same host and port as the WebSocket). */
export function serverHttpUrl(): string {
  return serverUrl().replace(/^ws/, 'http');
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
    account: null,
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
  const sentSession = useRef<string | null>(null);
  const actionSeq = useRef(0);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const socket = new WebSocket(serverUrl());
      ws.current = socket;
      socket.onopen = () => {
        setState((s) => ({ ...s, connected: true, notice: null }));
        sentSession.current = readSessionToken();
        socket.send(
          JSON.stringify({
            type: 'hello',
            token: sentSession.current ?? readToken(),
          } satisfies ClientMessage),
        );
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
        if (m.type === 'welcome') {
          if (m.account === null) {
            if (sentSession.current) clearSessionToken(); // expired or signed out elsewhere
            writeToken(m.token);
          }
          socket.send(JSON.stringify({ type: 'client.env', env: clientEnv() } satisfies ClientMessage));
        }
        if (m.type === 'view') viewRef.current = m.view;
      };
    };
    // Tab switches during a match are an integrity signal (SPEC §Integrity); stored for accounts only.
    const onVisibility = () => {
      const socket = ws.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const type = document.visibilityState === 'hidden' ? 'blur' : 'focus';
      socket.send(JSON.stringify({ type } satisfies ClientMessage));
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
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
    /** Say hello again after signing in or out, so the socket plays as the new identity. */
    rehello: () => {
      sentSession.current = readSessionToken();
      send({ type: 'hello', token: sentSession.current ?? readToken() });
    },
  };
}

function reduce(s: GameState, m: ServerMessage): GameState {
  switch (m.type) {
    case 'welcome':
      return { ...s, playerId: m.playerId, account: m.account, clockOffset: m.serverTime - Date.now() };
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
