import { z } from 'zod';
import { ClientMessageSchema, ServerMessageSchema } from './messages';

// JSON Schema exports of the WebSocket frames, for non-TypeScript clients (the Python agent service).
// Zod stays the single source of truth: the committed files are regenerated with `pnpm protocol:schema`,
// and a test fails if they are stale. Refinements zod cannot express in JSON Schema (e.g. a stake pass
// must be {to: null, amount: 0}) are still enforced by the server.

export function frameJsonSchemas(): Record<'client-message' | 'server-message', unknown> {
  const opts = { target: 'draft-2020-12', unrepresentable: 'any' } as const;
  return {
    'client-message': z.toJSONSchema(ClientMessageSchema, opts),
    'server-message': z.toJSONSchema(ServerMessageSchema, opts),
  };
}
