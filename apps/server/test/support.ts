import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { ServerMessageSchema, type ClientMessage, type ServerMessage } from '@canutell/protocol';
import type { PasskeyCeremonies } from '../src';

// Shared by the account and alpha server tests. The WebAuthn ceremony is faked: a "response" is accepted
// when it echoes the challenge. The real ceremony runs in the browser e2e test (apps/web/e2e/accounts.mjs).

export const fakeCeremonies: PasskeyCeremonies = {
  async registrationOptions() {
    return { challenge: randomBytes(16).toString('base64url') };
  },
  async verifyRegistration(response, challenge) {
    const r = response as { id: string; response: { clientDataJSON: string } };
    if (r.response.clientDataJSON !== challenge) return null;
    return {
      credentialId: r.id,
      publicKey: randomBytes(65),
      signCount: 0,
      transports: ['internal'],
      multiDevice: true,
      backedUp: true,
    };
  },
  async authenticationOptions() {
    return { challenge: randomBytes(16).toString('base64url') };
  },
  async verifyAuthentication(response, challenge, passkey) {
    const r = response as { id: string; response: { clientDataJSON: string } };
    if (r.response.clientDataJSON !== challenge || r.id !== passkey.credentialId) return null;
    return { signCount: passkey.signCount + 1, backedUp: true };
  },
};
export const credential = (id: string, challenge: string) => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: challenge },
  clientExtensionResults: {},
});

export class Client {
  frames: ServerMessage[] = [];
  closed = false;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessageSchema.parse(JSON.parse(String(d)));
      this.frames.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    ws.on('close', () => (this.closed = true));
  }
  static async connect(url: string, userAgent?: string): Promise<Client> {
    const ws = new WebSocket(url, userAgent ? { headers: { 'user-agent': userAgent } } : {});
    const c = new Client(ws);
    await new Promise((r) => ws.once('open', r));
    return c;
  }
  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }
  wait<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) {
    const hit = this.frames.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (hit) return Promise.resolve(hit as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
}
