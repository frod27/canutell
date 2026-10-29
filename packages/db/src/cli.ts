import { parseArgs } from 'node:util';
import { migrate, loadMigrations } from './migrate';
import { purgeMatchesWithFlag, rebuildAllDerived, rebuildDerived } from './queries';
import { pgSql } from './sql';
import { exportLatencyModel } from './latency-model';
import { humanlikeness } from './humanlikeness';
import { AccountError, deleteAccount, pendingReviews, restoreTrust, reviewSeat } from './accounts';
import { createInvite, listInvites, revokeInvite } from './invites';
import { formatOpsReport, opsReport } from './ops-report';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// pnpm db:migrate                      apply pending migrations
// pnpm db:status                       list applied / pending migrations
// pnpm db:derive [--match ID]          rebuild derived tables (all matches, or one)
// pnpm db:purge --flag phase3 --yes    privacy deletion of every match carrying the flag
// pnpm db:latency-model [--out FILE]   export the human response-time model for agents (aggregates only)
// pnpm db:humanlikeness                H per agent version (SPEC §Agents), non-party research matches only
// pnpm db:integrity pending            flagged account seats awaiting human review (no identity data)
// pnpm db:integrity review --match ID --seat N --decision cleared|confirmed --reviewer NAME [--note TEXT]
// pnpm db:integrity restore --player ID --level T1|T2|T3
// pnpm ops:invite create --uses N --label TEXT [--expires-days D]   prints the code once (stored hashed)
// pnpm ops:invite list | revoke --id N
// pnpm db:delete-account --match ID --seat N --yes   privacy deletion on a player's request (same path as /account)
// pnpm ops:report [--since-days 7]     how the alpha is going: fun first, then data (aggregates only)
// All commands use DATABASE_URL.

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2).filter((a) => a !== '--');
  const sub = command === 'integrity' || command === 'invite' ? args[0] : undefined;
  const rest = sub ? args.slice(1) : args;
  const { values } = parseArgs({
    args: rest,
    options: {
      match: { type: 'string' },
      flag: { type: 'string' },
      yes: { type: 'boolean', default: false },
      out: { type: 'string' },
      'min-samples': { type: 'string' },
      seat: { type: 'string' },
      decision: { type: 'string' },
      reviewer: { type: 'string' },
      note: { type: 'string' },
      player: { type: 'string' },
      level: { type: 'string' },
      uses: { type: 'string' },
      label: { type: 'string' },
      'expires-days': { type: 'string' },
      id: { type: 'string' },
      'since-days': { type: 'string' },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const sql = pgSql(url, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(sql);
        console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date');
        return 0;
      }
      case 'status': {
        const done = new Set(
          (await sql.query<{ version: string }>('select version from schema_migrations').catch(() => [])).map(
            (r) => r.version,
          ),
        );
        for (const m of loadMigrations())
          console.log(`${done.has(m.version) ? 'applied' : 'PENDING'}  ${m.name}`);
        return 0;
      }
      case 'derive': {
        if (values.match) {
          const rows = await rebuildDerived(sql, values.match);
          console.log(
            `${values.match}: ${rows.decisions.length} decisions, ${rows.stakes.length} stakes, ${rows.messages.length} messages`,
          );
        } else {
          let failed = 0;
          const n = await rebuildAllDerived(sql, (id, e) => {
            failed++;
            console.error(`${id}: ${String(e)}`);
          });
          console.log(`rebuilt ${n} match(es)${failed ? `, ${failed} FAILED` : ''}`);
          return failed ? 1 : 0;
        }
        return 0;
      }
      case 'purge': {
        if (!values.flag) throw new Error('--flag is required');
        if (!values.yes) {
          console.error(`this permanently deletes every match flagged "${values.flag}"; re-run with --yes`);
          return 2;
        }
        const out = await purgeMatchesWithFlag(sql, values.flag);
        console.log(`purged ${out.matches} match(es) and ${out.players} orphaned player(s)`);
        return 0;
      }
      case 'humanlikeness': {
        const rows = await humanlikeness(sql);
        if (rows.length === 0) console.log('no eligible matches yet (non-party, completed, not dev-flagged)');
        for (const r of rows) {
          console.log(
            `${r.agentVersion}: H = ${r.h === null ? 'n/a' : r.h.toFixed(3)}  ` +
              `(agent seats labeled human ${r.agentLabeledHuman}/${r.agentLabels}, ` +
              `human seats ${r.humanLabeledHuman}/${r.humanLabels})`,
          );
        }
        return 0;
      }
      case 'latency-model': {
        const model = await exportLatencyModel(sql, {
          minSamples: values['min-samples'] ? Number(values['min-samples']) : undefined,
        });
        const json = JSON.stringify(model, null, 2) + '\n';
        if (values.out) {
          mkdirSync(dirname(values.out), { recursive: true });
          writeFileSync(values.out, json);
        } else process.stdout.write(json);
        const usable = Object.values(model.decisions).filter((b) => b.n >= model.minSamples).length;
        console.error(
          `${Object.keys(model.decisions).length} buckets, ${usable} with >= ${model.minSamples} eligible human samples`,
        );
        return 0;
      }
      case 'integrity':
        try {
          return await integrity(sql, sub, values);
        } catch (e) {
          if (e instanceof AccountError) {
            console.error(`${e.code}: ${e.message}`);
            return 1;
          }
          throw e;
        }
      case 'invite':
        return await invite(sql, sub, values);
      case 'delete-account': {
        // Identified by the match and seat the player tells you, so the operator never handles player ids.
        const seat = Number(values.seat);
        if (!values.match || !Number.isInteger(seat) || !values.yes) {
          console.error('usage: db:delete-account --match ID --seat N --yes');
          return 2;
        }
        const [row] = await sql.query<{ player_id: string | null }>(
          `select s.player_id from seats s join identity.identities i using (player_id)
            where s.match_id = $1 and s.seat_id = $2`,
          [values.match, seat],
        );
        if (!row?.player_id) {
          console.error('no account holds that seat');
          return 1;
        }
        await deleteAccount(sql, row.player_id, Date.now());
        console.log(
          'deleted: identity, passkeys and sessions erased, consents revoked, seats kept as anonymous context',
        );
        return 0;
      }
      case 'report': {
        const days = Number(values['since-days'] ?? 7);
        if (!(days > 0)) {
          console.error('--since-days must be a positive number');
          return 2;
        }
        console.log(formatOpsReport(await opsReport(sql, { since: Date.now() - days * 86_400_000 })));
        return 0;
      }
      default:
        console.error(
          'usage: db <migrate|status|derive|purge|latency-model|humanlikeness|integrity|invite|report> [--match ID] [--flag F --yes] [--out FILE]',
        );
        return 2;
    }
  } finally {
    await sql.close();
  }
}

/** Human review of automation flags (SPEC §Integrity: flags never auto-ban without review). */
async function integrity(
  sql: ReturnType<typeof pgSql>,
  sub: string | undefined,
  v: Record<string, string | boolean | undefined>,
): Promise<number> {
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  if (sub === 'pending') {
    const rows = await pendingReviews(sql);
    for (const r of rows)
      console.log(
        `${r.matchId} seat ${r.seat}  ${new Date(r.matchCreatedAt).toISOString()}  ` +
          r.signals.map((s) => `${s.signal}=${Math.round(s.value * 1000) / 1000}`).join(' '),
      );
    console.error(`${rows.length} seat(s) awaiting review`);
    return 0;
  }
  if (sub === 'review') {
    const decision = str('decision');
    const match = str('match');
    const seat = Number(str('seat'));
    const reviewer = str('reviewer');
    if (
      !match ||
      !Number.isInteger(seat) ||
      !reviewer ||
      (decision !== 'cleared' && decision !== 'confirmed')
    ) {
      console.error(
        'usage: db integrity review --match ID --seat N --decision cleared|confirmed --reviewer NAME',
      );
      return 2;
    }
    await reviewSeat(sql, { matchId: match, seat, decision, reviewer, note: str('note'), now: Date.now() });
    console.log(`recorded: ${match} seat ${seat} ${decision}`);
    return 0;
  }
  if (sub === 'restore') {
    const player = str('player');
    const level = str('level');
    if (!player || (level !== 'T1' && level !== 'T2' && level !== 'T3')) {
      console.error('usage: db integrity restore --player ID --level T1|T2|T3');
      return 2;
    }
    await restoreTrust(sql, { playerId: player, level, now: Date.now() });
    console.log(`${player} is now ${level}`);
    return 0;
  }
  console.error('usage: db integrity <pending|review|restore>');
  return 2;
}

/** Closed-alpha invite codes (DECISIONS Phase 6). The code is printed once and stored only hashed. */
async function invite(
  sql: ReturnType<typeof pgSql>,
  sub: string | undefined,
  v: Record<string, string | boolean | undefined>,
): Promise<number> {
  if (sub === 'create') {
    const uses = Number(v.uses);
    const label = typeof v.label === 'string' ? v.label.trim() : '';
    const days = v['expires-days'] === undefined ? null : Number(v['expires-days']);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000 || !label || (days !== null && !(days > 0))) {
      console.error('usage: ops:invite create --uses 1..1000 --label TEXT [--expires-days D]');
      return 2;
    }
    const now = Date.now();
    const r = await createInvite(sql, {
      label,
      maxUses: uses,
      expiresAt: days ? now + days * 86_400_000 : null,
      now,
    });
    console.log(`invite ${r.inviteId} (${label}, ${uses} uses): ${r.code}`);
    console.error('The code is shown only now; it is stored hashed.');
    return 0;
  }
  if (sub === 'list') {
    for (const i of await listInvites(sql)) {
      const state = i.revokedAt ? 'revoked' : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : 'active';
      console.log(`${i.inviteId}  ${state}  ${i.uses}/${i.maxUses}  ${i.label}`);
    }
    return 0;
  }
  if (sub === 'revoke') {
    const id = Number(v.id);
    if (!Number.isInteger(id)) {
      console.error('usage: ops:invite revoke --id N');
      return 2;
    }
    console.log((await revokeInvite(sql, id, Date.now())) ? `revoked ${id}` : `no active invite ${id}`);
    return 0;
  }
  console.error('usage: ops:invite <create|list|revoke>');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
