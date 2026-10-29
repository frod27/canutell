import { humanlikeness, type HumanlikenessRow } from './humanlikeness';
import { EXCLUDED_FLAGS } from './latency-model';
import { iso } from './queries';
import type { Sql } from './sql';

// `pnpm ops:report`: how the closed alpha is going (DECISIONS Phase 6). Aggregates only, never a player
// id. "Fun first": completion, return rate and the survey; then data: the training pool, trust, flags, H.
// Queue waits are not stored in the database; the server logs them per match ("formed … waits").

export interface OpsReport {
  since: string;
  matches: {
    started: number;
    completed: number;
    aborted: number;
    party: number;
    completionRate: number | null;
  };
  /** Completed non-party matches with no dev/bot-fill/sped-up flag. */
  researchMatches: number;
  players: { active: number; returning: number; returnRate: number | null };
  survey: { answers: number; meanFun: number | null; medianFun: number | null; tags: Record<string, number> };
  accounts: { byTrust: Record<string, number>; researchConsent: number; deleted: number };
  trainingSeats: number;
  pendingReviews: number;
  /** Matches in which 2+ human seats came in through the same invite (friends: detection bias). */
  sharedInviteMatches: number;
  agentFlags: Record<string, number>;
  invites: { active: number; used: number; capacity: number };
  humanlikeness: HumanlikenessRow[];
}

const n = (v: unknown): number => Number(v ?? 0);

export async function opsReport(sql: Sql, o: { since: number }): Promise<OpsReport> {
  const since = iso(o.since);
  const excluded = [...EXCLUDED_FLAGS];
  const [m] = await sql.query<Record<string, unknown>>(
    `select count(*) as started,
            count(*) filter (where status = 'completed') as completed,
            count(*) filter (where status = 'aborted') as aborted,
            count(*) filter (where is_party) as party,
            count(*) filter (where status = 'completed' and not is_party and not (flags && $2::text[])) as research
       from matches where created_at >= $1::timestamptz`,
    [since, excluded],
  );
  const started = n(m!.started);
  const completed = n(m!.completed);
  const finished = completed + n(m!.aborted);

  const [p] = await sql.query<Record<string, unknown>>(
    `with played as (
       select s.player_id, count(*) as k
         from seats s join matches mm using (match_id)
         join identity.identities i on i.player_id = s.player_id
        where s.kind = 'human' and mm.status = 'completed' and mm.created_at >= $1::timestamptz
        group by s.player_id)
     select count(*) as active, count(*) filter (where k >= 2) as returning from played`,
    [since],
  );
  const active = n(p!.active);

  const fb = await sql.query<{ fun: number; tags: string[] }>(
    `select f.fun, f.tags from match_feedback f join matches mm using (match_id)
      where mm.created_at >= $1::timestamptz order by f.fun`,
    [since],
  );
  const tags: Record<string, number> = {};
  for (const f of fb) for (const t of f.tags) tags[t] = (tags[t] ?? 0) + 1;
  const funs = fb.map((f) => f.fun);
  const median = funs.length
    ? funs.length % 2
      ? funs[(funs.length - 1) / 2]!
      : (funs[funs.length / 2 - 1]! + funs[funs.length / 2]!) / 2
    : null;

  const trust = await sql.query<{ trust_level: string; k: unknown }>(
    `select p.trust_level, count(*) as k from players p join identity.identities i using (player_id)
      where p.deleted_at is null group by p.trust_level order by p.trust_level`,
  );
  const [acc] = await sql.query<Record<string, unknown>>(
    `select (select count(*) from active_research_consent) as research,
            (select count(*) from players where deleted_at is not null) as deleted,
            (select count(*) from training_seats t join matches mm using (match_id)
              where mm.created_at >= $1::timestamptz) as pool,
            (select count(distinct (i.match_id, i.seat_id)) from integrity_signals i
               join seats s on s.match_id = i.match_id and s.seat_id = i.seat_id
              where i.flagged and s.kind = 'human'
                and not exists (select 1 from integrity_reviews r
                                 where r.match_id = i.match_id and r.seat_id = i.seat_id)) as pending`,
    [since],
  );
  const [shared] = await sql.query<Record<string, unknown>>(
    `select count(distinct x.match_id) as k from (
       select s.match_id from seats s
         join matches mm using (match_id)
         join identity.identities i on i.player_id = s.player_id
        where s.kind = 'human' and i.invite_id is not null and mm.created_at >= $1::timestamptz
        group by s.match_id, i.invite_id having count(*) >= 2) x`,
    [since],
  );
  const flags = await sql.query<{ flag: string; k: unknown }>(
    `select f as flag, count(*) as k from matches, unnest(flags) as f
      where created_at >= $1::timestamptz
        and f in ('scripted_agents', 'baseline_agents', 'agent_fallback', 'latency_prior', 'scripted_chat')
      group by f order by f`,
    [since],
  );
  const [inv] = await sql.query<Record<string, unknown>>(
    `select count(*) filter (where revoked_at is null and uses < max_uses
                               and (expires_at is null or expires_at > now())) as active,
            coalesce(sum(uses), 0) as used, coalesce(sum(max_uses), 0) as capacity
       from identity.invites`,
  );

  return {
    since,
    matches: {
      started,
      completed,
      aborted: n(m!.aborted),
      party: n(m!.party),
      completionRate: finished ? completed / finished : null,
    },
    researchMatches: n(m!.research),
    players: { active, returning: n(p!.returning), returnRate: active ? n(p!.returning) / active : null },
    survey: {
      answers: funs.length,
      meanFun: funs.length ? funs.reduce((a, b) => a + b, 0) / funs.length : null,
      medianFun: median,
      tags,
    },
    accounts: {
      byTrust: Object.fromEntries(trust.map((t) => [t.trust_level, n(t.k)])),
      researchConsent: n(acc!.research),
      deleted: n(acc!.deleted),
    },
    trainingSeats: n(acc!.pool),
    pendingReviews: n(acc!.pending),
    sharedInviteMatches: n(shared!.k),
    agentFlags: Object.fromEntries(flags.map((f) => [f.flag, n(f.k)])),
    invites: { active: n(inv!.active), used: n(inv!.used), capacity: n(inv!.capacity) },
    humanlikeness: await humanlikeness(sql),
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const num = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));

export function formatOpsReport(r: OpsReport): string {
  const lines = [
    `CANUTELL alpha report since ${r.since}`,
    '',
    'Fun',
    `  matches: ${r.matches.started} started, ${r.matches.completed} completed, ${r.matches.aborted} aborted ` +
      `(completion ${pct(r.matches.completionRate)}), ${r.matches.party} party`,
    `  players: ${r.players.active} active, ${r.players.returning} returning (${pct(r.players.returnRate)})`,
    `  survey: ${r.survey.answers} answers, mean fun ${num(r.survey.meanFun)}, median ${num(r.survey.medianFun, 1)}`,
    `  tags: ${
      Object.entries(r.survey.tags)
        .map(([t, k]) => `${t} ${k}`)
        .join(', ') || '—'
    }`,
    '  queue waits: in the server log ("formed … waits")',
    '',
    'Data',
    `  research-eligible matches: ${r.researchMatches}; training-pool seats: ${r.trainingSeats}`,
    `  accounts by trust: ${
      Object.entries(r.accounts.byTrust)
        .map(([t, k]) => `${t} ${k}`)
        .join(', ') || '—'
    }; ` + `research consent ${r.accounts.researchConsent}; deleted ${r.accounts.deleted}`,
    `  flags awaiting review: ${r.pendingReviews}; matches with 2+ players from one invite: ${r.sharedInviteMatches}`,
    `  agent flags: ${
      Object.entries(r.agentFlags)
        .map(([f, k]) => `${f} ${k}`)
        .join(', ') || '—'
    }`,
    `  invites: ${r.invites.active} active, ${r.invites.used}/${r.invites.capacity} uses`,
    `  H: ${r.humanlikeness.map((h) => `${h.agentVersion} ${num(h.h)} (${h.agentLabels} labels)`).join(', ') || 'no eligible ballots yet'}`,
  ];
  return lines.join('\n');
}
