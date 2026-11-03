'use client';

import { useEffect, useState } from 'react';
import type { StudioAgentSummary } from '@canutell/protocol';
import { myAgents } from '@/lib/studio';

/**
 * "Play with your agent" (SPEC §Agents, Studio): a signed-in maker adds one of their own active agents to
 * the party. Everyone in the party knows it's there, so these matches never count toward detection or H.
 */
export function PartyAgent({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (agentId: number | null) => void;
}) {
  const [agents, setAgents] = useState<StudioAgentSummary[]>([]);
  useEffect(() => {
    myAgents().then(
      (a) => setAgents(a.filter((x) => x.status === 'active')),
      () => setAgents([]),
    );
  }, []);
  if (current)
    return (
      <p className="small">
        Playing with agent <strong data-testid="party-agent">{current}</strong>.{' '}
        <button className="secondary small" onClick={() => onPick(null)}>
          Remove
        </button>
      </p>
    );
  if (agents.length === 0) return null;
  return (
    <div className="row wrap small">
      <span>Add your agent:</span>
      {agents.map((a) => (
        <button key={a.agentId} className="secondary small" onClick={() => onPick(a.agentId)}>
          {a.name}
        </button>
      ))}
    </div>
  );
}
