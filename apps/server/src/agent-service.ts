import { z } from 'zod';

// Client for the Python agent service (services/agents). For each agent seat the server POSTs
// {serverUrl, token, agentVersion, clockSpeed}; the service then connects over the public WebSocket protocol
// with that token, like any player (CLAUDE.md invariant 15). Nothing about the match is sent.

export const BASELINE_AGENT_VERSION = 'baseline-1';

const SeatResponseSchema = z.object({
  accepted: z.literal(true),
  agentVersion: z.string(),
  flags: z.array(z.string()),
});

export interface AgentSeat {
  agentVersion: string;
  /** Data-quality flags the agent reports, e.g. latency_prior, scripted_chat. */
  flags: string[];
}

export type AgentSeater = (args: {
  serverUrl: string;
  token: string;
  clockSpeed: number;
}) => Promise<AgentSeat | null>;

/**
 * Returns null (→ the server falls back to a scripted bot) on any failure, within `timeoutMs` (default 2 s,
 * below the server's default formation delay of 2.5 s so seating never lengthens formation).
 */
export function agentServiceSeater(opts: {
  url: string;
  secret: string;
  agentVersion?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}): AgentSeater {
  const version = opts.agentVersion ?? BASELINE_AGENT_VERSION;
  return async ({ serverUrl, token, clockSpeed }) => {
    try {
      const res = await fetch(`${opts.url.replace(/\/$/, '')}/seats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-secret': opts.secret },
        body: JSON.stringify({ serverUrl, token, agentVersion: version, clockSpeed }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
      });
      if (!res.ok) {
        opts.log?.(`agent service refused a seat: HTTP ${res.status}`);
        return null;
      }
      const body = SeatResponseSchema.safeParse(await res.json());
      if (!body.success || body.data.agentVersion !== version) {
        opts.log?.('agent service answered with an unexpected body');
        return null;
      }
      return { agentVersion: body.data.agentVersion, flags: body.data.flags };
    } catch (e) {
      opts.log?.(`agent service unreachable: ${String(e)}`);
      return null;
    }
  };
}
