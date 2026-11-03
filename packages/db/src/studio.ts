import {
  checkAgentName,
  checkStyleHint,
  parseStudioVersion,
  STUDIO_LIMITS,
  studioVersionLabel,
  type Leaderboard,
  type StudioAgentSummary,
  type StudioConfig,
  type StudioStats,
} from '@canutell/protocol';
import { maskChat } from '@canutell/engine';
import { AccountError, setConsent } from './accounts';
import { EXCLUDED_FLAGS } from './latency-model';
import { iso } from './queries';
import type { Sql } from './sql';

// Agent Studio (Phase 7; SPEC §Agents, Studio). Makers own agents; every saved change is a new immutable
// agent_versions row (`studio:<id>:v<n>`) so each version's record stays comparable. Makers see aggregates
// only. Studio agent seats are never training data (CLAUDE.md invariant 10), and a maker's own seat in a
// match with their agent isn't either (the training_seats view, migration 0006).

export class StudioError extends Error {
  constructor(
    readonly code:
      'not_eligible' | 'too_many_agents' | 'bad_name' | 'name_taken' | 'bad_style' | 'not_found' | 'retired',
    message: string,
  ) {
    super(message);
  }
}

export interface StudioVersionInfo {
  agentVersion: string;
  agentId: number;
  ownerId: string;
  name: string;
  config: StudioConfig;
}

const CHAT_MODEL_NOTE =
  "claude-haiku-5-5 by default (AGENT_CHAT_MODEL), with the maker's style hint below the rules";

function cleanConfig(config: StudioConfig): StudioConfig {
  const style = config.style.trim();
  const problem = checkStyleHint(style);
  if (problem) throw new StudioError('bad_style', `style hint: ${problem}`);
  return { traits: config.traits, style: maskChat(style).text };
}

async function insertVersion(tx: Sql, agentId: number, config: StudioConfig, now: number): Promise<string> {
  const [{ n }] = (await tx.query<{ n: number }>(
    'select count(*)::int as n from agent_versions where studio_agent_id = $1',
    [agentId],
  )) as [{ n: number }];
  const label = studioVersionLabel(agentId, n + 1);
  await tx.query(
    `insert into agent_versions (agent_version, class, decision_model, chat_model, released_at, studio_agent_id, config)
     values ($1, 'studio', 'baseline-1 policy with maker traits', $2, $3::timestamptz, $4, $5::jsonb)`,
    [label, CHAT_MODEL_NOTE, iso(now), agentId, JSON.stringify(config)],
  );
  return label;
}

/**
 * A new Studio agent with its first version. The maker must be a confirmed-18+ account (T2+), accepts the
 * Studio terms (consent `studio`), and may have at most STUDIO_LIMITS.maxAgents active or paused agents.
 */
export async function createStudioAgent(
  sql: Sql,
  a: { ownerId: string; name: string; config: StudioConfig; now: number },
): Promise<{ agentId: number; agentVersion: string }> {
  const name = a.name.trim();
  const problem = checkAgentName(name);
  if (problem) throw new StudioError('bad_name', `name: ${problem}`);
  const config = cleanConfig(a.config);
  return sql.transaction(async (tx) => {
    const [p] = await tx.query<{ ok: boolean }>(
      `select (trust_level >= 'T2' and deleted_at is null) as ok from players where player_id = $1 for update`,
      [a.ownerId],
    );
    if (!p?.ok) throw new StudioError('not_eligible', 'Studio agents need a confirmed 18+ account');
    const [{ k }] = (await tx.query<{ k: number }>(
      `select count(*)::int as k from studio_agents where owner_id = $1 and status <> 'retired'`,
      [a.ownerId],
    )) as [{ k: number }];
    if (k >= STUDIO_LIMITS.maxAgents) throw new StudioError('too_many_agents', 'retire an agent first');
    const taken = await tx.query('select 1 from studio_agents where lower(name) = lower($1)', [name]);
    if (taken.length) throw new StudioError('name_taken', 'that name is taken');
    await setConsent(tx, a.ownerId, 'studio', true, a.now);
    const [r] = await tx.query<{ agent_id: number }>(
      `insert into studio_agents (owner_id, name, created_at) values ($1, $2, $3::timestamptz) returning agent_id`,
      [a.ownerId, name, iso(a.now)],
    );
    const agentId = Number(r!.agent_id);
    return { agentId, agentVersion: await insertVersion(tx, agentId, config, a.now) };
  });
}

async function ownedAgent(tx: Sql, ownerId: string, agentId: number) {
  const [row] = await tx.query<{ status: string }>(
    'select status from studio_agents where agent_id = $1 and owner_id = $2 for update',
    [agentId, ownerId],
  );
  if (!row) throw new StudioError('not_found', 'no such agent');
  return row;
}

/** Save a change as a new version. Its record starts fresh, and a paused agent is active again. */
export async function saveStudioVersion(
  sql: Sql,
  a: { ownerId: string; agentId: number; config: StudioConfig; now: number },
): Promise<string> {
  const config = cleanConfig(a.config);
  return sql.transaction(async (tx) => {
    const row = await ownedAgent(tx, a.ownerId, a.agentId);
    if (row.status === 'retired') throw new StudioError('retired', 'this agent is retired');
    const label = await insertVersion(tx, a.agentId, config, a.now);
    await tx.query(`update studio_agents set status = 'active', paused_reason = null where agent_id = $1`, [
      a.agentId,
    ]);
    return label;
  });
}

export async function retireStudioAgent(sql: Sql, ownerId: string, agentId: number): Promise<void> {
  await sql.transaction(async (tx) => {
    await ownedAgent(tx, ownerId, agentId);
    await tx.query(`update studio_agents set status = 'retired' where agent_id = $1`, [agentId]);
  });
}

/** The version number, from the label `studio:<id>:v<n>` (never from timestamps, which can tie). */
const VERSION_N = `substring(v.agent_version from ':v([0-9]+)$')::int`;

/** The current (latest) version of each of the given agents. */
async function currentVersions(
  sql: Sql,
  where: string,
  params: unknown[],
): Promise<
  (StudioVersionInfo & {
    status: string;
    pausedReason: string | null;
    versionNumber: number;
  })[]
> {
  const rows = await sql.query<{
    agent_version: string;
    agent_id: number;
    owner_id: string;
    name: string;
    status: string;
    paused_reason: string | null;
    config: StudioConfig;
    n: number;
  }>(
    `select distinct on (sa.agent_id) v.agent_version, sa.agent_id, sa.owner_id, sa.name, sa.status, sa.paused_reason,
            v.config, ${VERSION_N} as n
       from studio_agents sa join agent_versions v on v.studio_agent_id = sa.agent_id
      where ${where}
      order by sa.agent_id, ${VERSION_N} desc`,
    params,
  );
  return rows.map((r) => ({
    agentVersion: r.agent_version,
    agentId: Number(r.agent_id),
    ownerId: r.owner_id,
    name: r.name,
    status: r.status,
    pausedReason: r.paused_reason,
    config: r.config,
    versionNumber: r.n,
  }));
}

/** Public matches each agent played in the last 24 hours (quota). */
async function matchesToday(sql: Sql, agentIds: number[], now: number): Promise<Map<number, number>> {
  const rows = await sql.query<{ agent_id: number; k: number }>(
    `select v.studio_agent_id as agent_id, count(*)::int as k
       from seats s join agent_versions v using (agent_version) join matches m using (match_id)
      where v.studio_agent_id = any($1::bigint[]) and not m.is_party and m.created_at > $2::timestamptz
      group by v.studio_agent_id`,
    [agentIds, iso(now - 86_400_000)],
  );
  return new Map(rows.map((r) => [Number(r.agent_id), r.k]));
}

/** Aggregates for one version: never match ids, players or messages. */
export async function studioStats(sql: Sql, agentVersion: string): Promise<StudioStats> {
  const [m] = await sql.query<{ matches: number; avg: number | null }>(
    `select count(*)::int as matches, avg(r.final_score)::float as avg
       from seats s join matches mm using (match_id)
       left join seat_results r on r.match_id = s.match_id and r.seat_id = s.seat_id
      where s.agent_version = $1 and mm.status = 'completed'`,
    [agentVersion],
  );
  // Labels as for H: consented T2+ voters (training_seats), non-party, non-dev matches.
  const [l] = await sql.query<{ labels: number; human: number }>(
    `select count(*)::int as labels, count(*) filter (where b.label = 'human')::int as human
       from ballots b
       join seats t on t.match_id = b.match_id and t.seat_id = b.target_seat
       join matches mm on mm.match_id = b.match_id
       join training_seats tv on tv.match_id = b.match_id and tv.seat_id = b.voter_seat
      where t.agent_version = $1 and b.label is not null and not mm.is_party
        and not (mm.flags && $2::text[])`,
    [agentVersion, [...EXCLUDED_FLAGS]],
  );
  const [s] = await sql.query<{ k: number }>(
    'select count(*)::int as k from studio_strikes where agent_version = $1',
    [agentVersion],
  );
  return {
    matches: m!.matches,
    labels: l!.labels,
    labeledHuman: l!.human,
    humanRate: l!.labels > 0 ? l!.human / l!.labels : null,
    averageScore: m!.avg === null ? null : Math.round(m!.avg * 10) / 10,
    strikes: s!.k,
  };
}

/** The maker's own agents (current version each) with aggregates. */
export async function listMyAgents(sql: Sql, ownerId: string, now: number): Promise<StudioAgentSummary[]> {
  const agents = await currentVersions(sql, 'sa.owner_id = $1', [ownerId]);
  const today = await matchesToday(
    sql,
    agents.map((a) => a.agentId),
    now,
  );
  const out: StudioAgentSummary[] = [];
  for (const a of agents)
    out.push({
      agentId: a.agentId,
      name: a.name,
      status: a.status as StudioAgentSummary['status'],
      pausedReason: a.pausedReason,
      version: a.agentVersion,
      versionNumber: a.versionNumber,
      config: a.config,
      stats: await studioStats(sql, a.agentVersion),
      matchesToday: today.get(a.agentId) ?? 0,
    });
  return out;
}

/**
 * Current versions that may take a public agent seat now: active, within today's quota, and not owned by
 * anyone in `excludeOwners` (the humans of the match being formed and their party).
 */
export async function eligibleStudioVersions(
  sql: Sql,
  o: { excludeOwners: readonly string[]; now: number },
): Promise<StudioVersionInfo[]> {
  const agents = await currentVersions(sql, `sa.status = 'active' and not (sa.owner_id = any($1::text[]))`, [
    [...o.excludeOwners],
  ]);
  const today = await matchesToday(
    sql,
    agents.map((a) => a.agentId),
    o.now,
  );
  return agents.filter((a) => (today.get(a.agentId) ?? 0) < STUDIO_LIMITS.matchesPerDay);
}

/** The maker's own active agent for a private party ("play with your agent"), or null. */
export async function ownAgentForParty(
  sql: Sql,
  ownerId: string,
  agentId: number,
): Promise<StudioVersionInfo | null> {
  const [a] = await currentVersions(sql, `sa.agent_id = $1 and sa.owner_id = $2 and sa.status = 'active'`, [
    agentId,
    ownerId,
  ]);
  return a ?? null;
}

/** Records a safety-filter block against a Studio version; the third pauses the agent. */
export async function recordStrike(
  sql: Sql,
  s: { agentVersion: string; matchId: string; reason: string; now: number },
): Promise<{ paused: boolean }> {
  return sql.transaction(async (tx) => {
    const [v] = await tx.query<{ studio_agent_id: number | null }>(
      `select v.studio_agent_id from agent_versions v
         join seats st on st.agent_version = v.agent_version and st.match_id = $2
        where v.agent_version = $1 and v.class = 'studio'`,
      [s.agentVersion, s.matchId],
    );
    if (!v?.studio_agent_id) throw new AccountError('not_found', 'no such studio seat');
    await tx.query(
      `insert into studio_strikes (agent_version, match_id, reason, at) values ($1, $2, $3, $4::timestamptz)`,
      [s.agentVersion, s.matchId, s.reason.slice(0, 64), iso(s.now)],
    );
    const [{ k }] = (await tx.query<{ k: number }>(
      'select count(*)::int as k from studio_strikes where agent_version = $1',
      [s.agentVersion],
    )) as [{ k: number }];
    if (k >= STUDIO_LIMITS.strikesToPause) {
      await tx.query(
        `update studio_agents set status = 'paused', paused_reason = $2 where agent_id = $1 and status = 'active'`,
        [v.studio_agent_id, `${k} lines blocked by the safety filter; save a new version to resume`],
      );
      return { paused: true };
    }
    return { paused: false };
  });
}

/** Public leaderboard: how often each version was labelled human, once it has enough labels. */
export async function studioLeaderboard(sql: Sql): Promise<Leaderboard> {
  const versions = await sql.query<{ agent_version: string; name: string }>(
    `select v.agent_version, sa.name from agent_versions v join studio_agents sa on sa.agent_id = v.studio_agent_id`,
  );
  const entries: Leaderboard['entries'] = [];
  for (const v of versions) {
    const s = await studioStats(sql, v.agent_version);
    if (s.labels >= STUDIO_LIMITS.minLeaderboardLabels)
      entries.push({
        name: v.name,
        versionNumber: parseStudioVersion(v.agent_version)!.n,
        labels: s.labels,
        humanRate: s.labeledHuman / s.labels,
      });
  }
  entries.sort((a, b) => b.humanRate - a.humanRate || b.labels - a.labels);
  return { minLabels: STUDIO_LIMITS.minLeaderboardLabels, entries };
}

/** Public display names for Studio versions (shown at Reveal). Unknown labels are left out. */
export async function studioNames(
  sql: Sql,
  labels: readonly string[],
): Promise<Record<string, { name: string; versionNumber: number }>> {
  const rows = await sql.query<{ agent_version: string; name: string }>(
    `select v.agent_version, sa.name
       from agent_versions v join studio_agents sa on sa.agent_id = v.studio_agent_id
      where v.agent_version = any($1::text[])`,
    [[...labels]],
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.agent_version,
      { name: r.name, versionNumber: parseStudioVersion(r.agent_version)!.n },
    ]),
  );
}
