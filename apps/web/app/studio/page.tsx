'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  STUDIO_LIMITS,
  checkAgentName,
  checkStyleHint,
  type StudioAgentSummary,
  type StudioConfig,
} from '@canutell/protocol';
import { ConsentBlock } from '@/components/AccountParts';
import { readSession } from '@/lib/account';
import {
  DEFAULT_CONFIG,
  StudioApiError,
  TRAIT_LABELS,
  createAgent,
  myAgents,
  retireAgent,
  saveVersion,
  studioErrorText,
} from '@/lib/studio';

// Agent Studio (Phase 7; SPEC §Agents, Studio): make an AI player, send it to play, watch its record.
// Makers see totals only. Timing, safety rules and what an agent sees are the platform's.

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

function ConfigEditor({ value, onChange }: { value: StudioConfig; onChange: (c: StudioConfig) => void }) {
  const styleProblem = checkStyleHint(value.style);
  return (
    <div className="stack">
      {TRAIT_LABELS.map((t) => (
        <label key={t.key} className="stack small">
          <span>
            <strong>{t.label}</strong>{' '}
            <span className="muted">
              — {t.low} ↔ {t.high}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            aria-label={t.label}
            value={Math.round(value.traits[t.key] * 100)}
            onChange={(e) =>
              onChange({ ...value, traits: { ...value.traits, [t.key]: Number(e.target.value) / 100 } })
            }
          />
        </label>
      ))}
      <label className="stack small">
        <strong>Style hint</strong>
        <textarea
          aria-label="Style hint"
          placeholder="e.g. dry humour, short sentences, suspicious of big stakes"
          maxLength={STUDIO_LIMITS.styleMax}
          rows={2}
          value={value.style}
          onChange={(e) => onChange({ ...value, style: e.target.value })}
        />
        <span className="muted">
          {value.style.length}/{STUDIO_LIMITS.styleMax}. It shapes how your agent sounds; it can’t change the
          rules.
          {styleProblem === 'link' && ' No links.'}
          {styleProblem === 'contact' && ' No contact details.'}
        </span>
      </label>
    </div>
  );
}

function AgentCard({
  a,
  onChange,
}: {
  a: StudioAgentSummary;
  onChange: (agents: StudioAgentSummary[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState(a.config);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<StudioAgentSummary[]>) => {
    setError(null);
    try {
      onChange(await fn());
      setEditing(false);
    } catch (e) {
      setError(e instanceof StudioApiError ? studioErrorText(e.code) : 'That didn’t work.');
    }
  };
  return (
    <section className="card" data-testid={`agent-${a.name}`}>
      <h3>
        {a.name} <span className="muted">v{a.versionNumber}</span> <span className="tag">{a.status}</span>
      </h3>
      {a.pausedReason && <p className="notice">Paused: {a.pausedReason}</p>}
      <p className="small">
        {a.stats.matches} matches · labelled human {pct(a.stats.humanRate)} ({a.stats.labels} labels) ·
        average score {a.stats.averageScore ?? '—'} · strikes {a.stats.strikes} · today {a.matchesToday}/
        {STUDIO_LIMITS.matchesPerDay}
      </p>
      {a.status !== 'retired' &&
        (editing ? (
          <>
            <ConfigEditor value={config} onChange={setConfig} />
            <p className="muted small">
              Saving makes version {a.versionNumber + 1}; its record starts fresh.
            </p>
            <div className="row">
              <button onClick={() => run(() => saveVersion(a.agentId, config))}>Save new version</button>
              <button className="secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            <button className="secondary" onClick={() => setEditing(true)}>
              {a.status === 'paused' ? 'Fix and resume' : 'Edit'}
            </button>
            <button className="secondary" onClick={() => run(() => retireAgent(a.agentId))}>
              Retire
            </button>
          </div>
        ))}
      {error && <p className="notice">{error}</p>}
    </section>
  );
}

export default function StudioPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<StudioAgentSummary[] | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_CONFIG);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!readSession()) return router.replace('/signin');
    try {
      setAgents(await myAgents());
    } catch {
      router.replace('/signin');
    }
  }, [router]);
  useEffect(() => void load(), [load]);

  if (!agents)
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  const active = agents.filter((a) => a.status !== 'retired');
  const nameProblem = name ? checkAgentName(name) : null;
  return (
    <main>
      <h1>CANUTELL</h1>
      <p>
        <Link href="/">← Play</Link> · <Link href="/leaderboard">Leaderboard</Link>
      </p>
      <section className="card">
        <h2>Agent Studio</h2>
        <p>
          Make an AI player and send it to play. Other players try to tell it from a human; it’s always
          revealed at the end, with its name.
        </p>
      </section>
      {agents.map((a) => (
        <AgentCard key={a.agentId} a={a} onChange={setAgents} />
      ))}
      {active.length < STUDIO_LIMITS.maxAgents && (
        <section className="card">
          <h3>New agent</h3>
          <input
            aria-label="Agent name"
            placeholder="Name (e.g. Marlowe)"
            maxLength={STUDIO_LIMITS.nameMax}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {nameProblem && <p className="muted small">{studioErrorText('bad_name')}</p>}
          <ConfigEditor value={config} onChange={setConfig} />
          {agents.length === 0 && (
            <>
              <ConsentBlock type="studio" />
              <label className="small">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I
                agree to the Studio terms
              </label>
            </>
          )}
          <button
            disabled={
              !name ||
              nameProblem !== null ||
              checkStyleHint(config.style) !== null ||
              (agents.length === 0 && !agreed)
            }
            onClick={async () => {
              setError(null);
              try {
                setAgents(await createAgent(name.trim(), config));
                setName('');
                setConfig(DEFAULT_CONFIG);
              } catch (e) {
                setError(e instanceof StudioApiError ? studioErrorText(e.code) : 'That didn’t work.');
              }
            }}
          >
            Make agent
          </button>
          {error && <p className="notice">{error}</p>}
        </section>
      )}
    </main>
  );
}
