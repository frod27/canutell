import type { Sql } from './sql';
import { EXCLUDED_FLAGS } from './latency-model';

// SPEC §Agents: Humanlikeness per agent version, H = P(labeled human | agent) / P(labeled human | human),
// computed from non-party matches (CLAUDE.md invariant 11). Only non-blank labels from voters in the
// training pool count: evaluation needs T2+ and active research consent (DECISIONS "What each data use
// requires"), and agents' ballots are never scored. Dev-flagged, bot-filled and sped-up matches are
// excluded, so until real play exists (closed alpha) this reports no data. H = 1 means indistinguishable.

export interface HumanlikenessRow {
  agentVersion: string;
  /** Labels given to this version's seats, and how many said "human". */
  agentLabels: number;
  agentLabeledHuman: number;
  /** Labels given to human seats in the same matches, and how many said "human". */
  humanLabels: number;
  humanLabeledHuman: number;
  /** null when either denominator is 0. */
  h: number | null;
}

export async function humanlikeness(sql: Sql): Promise<HumanlikenessRow[]> {
  const rows = await sql.query<{
    agent_version: string;
    agent_labels: number;
    agent_human: number;
    human_labels: number;
    human_human: number;
  }>(
    `with eligible as (
       select m.match_id from matches m
        where not m.is_party and m.status = 'completed' and not (m.flags && $1::text[])
     ),
     labels as (
       select b.match_id, b.label, t.is_agent as target_is_agent
         from ballots b
         join eligible e on e.match_id = b.match_id
         join seats t on t.match_id = b.match_id and t.seat_id = b.target_seat
         join training_seats tv on tv.match_id = b.match_id and tv.seat_id = b.voter_seat
        where b.label is not null
     ),
     versions as (
       select distinct s.match_id, s.agent_version from seats s join eligible e using (match_id) where s.is_agent
     )
     select v.agent_version,
            count(*) filter (where l.target_is_agent)::int as agent_labels,
            count(*) filter (where l.target_is_agent and l.label = 'human')::int as agent_human,
            count(*) filter (where not l.target_is_agent)::int as human_labels,
            count(*) filter (where not l.target_is_agent and l.label = 'human')::int as human_human
       from versions v join labels l on l.match_id = v.match_id
      group by v.agent_version
      order by v.agent_version`,
    [[...EXCLUDED_FLAGS]],
  );
  return rows.map((r) => {
    const pAgent = r.agent_labels > 0 ? r.agent_human / r.agent_labels : null;
    const pHuman = r.human_labels > 0 ? r.human_human / r.human_labels : null;
    return {
      agentVersion: r.agent_version,
      agentLabels: r.agent_labels,
      agentLabeledHuman: r.agent_human,
      humanLabels: r.human_labels,
      humanLabeledHuman: r.human_human,
      h: pAgent !== null && pHuman !== null && pHuman > 0 ? pAgent / pHuman : null,
    };
  });
}
