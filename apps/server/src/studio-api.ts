import type { IncomingMessage } from 'node:http';
import {
  createStudioAgent,
  listMyAgents,
  retireStudioAgent,
  saveStudioVersion,
  StudioError,
  studioLeaderboard,
  studioNames,
  type Sql,
} from '@canutell/db';
import {
  StudioCreateRequestSchema,
  StudioVersionRequestSchema,
  type AccountSummary,
  type Leaderboard,
} from '@canutell/protocol';
import type { RateTake } from './rate-limit';
import type { z } from 'zod';

// Agent Studio over HTTP (Phase 7; SPEC §Agents, Studio).
//
//   GET  /api/studio/agents                      my agents, with aggregates          (session)
//   POST /api/studio/agents                      {name, config, studioTermsVersion}  (session, T2+)
//   POST /api/studio/agents/:id/versions         {config}: a new version             (session)
//   POST /api/studio/agents/:id/retire                                               (session)
//   GET  /api/studio/leaderboard                 how often versions were labelled human (public)
//   GET  /api/studio/names?v=studio:1:v2,…       display names for Reveal              (public)
//
// Makers see aggregates only: never match ids, players or messages.

const MAX_BODY = 16 * 1024;
const MAX_NAMES = 12;
const LEADERBOARD_TTL_MS = 60_000;

export class StudioApi {
  constructor(
    private readonly o: {
      sql: Sql;
      resolve: (token: string) => Promise<AccountSummary | null>;
      now?: () => number;
      log?: (msg: string) => void;
      /** Per-account rate limits on writes (server.ts passes the server's limiter). */
      limit?: RateTake;
    },
  ) {}

  /** The leaderboard costs a query per version, so it is computed at most once a minute. */
  private board: { at: number; value: Promise<Leaderboard> } | null = null;

  private leaderboard(): Promise<Leaderboard> {
    const now = Date.now();
    if (!this.board || now - this.board.at > LEADERBOARD_TTL_MS) {
      const value = studioLeaderboard(this.o.sql);
      this.board = { at: now, value };
      value.catch(() => (this.board = null));
    }
    return this.board.value;
  }

  private limit(rule: 'studioWrite' | 'studioCreate', playerId: string): void {
    const wait = this.o.limit?.(rule, playerId) ?? 0;
    if (wait > 0) throw new HttpError(429, 'rate_limited', { retryAfterMs: wait });
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  handle(req: IncomingMessage, path: string, reply: (status: number, body?: unknown) => void): boolean {
    if (!path.startsWith('/api/studio/')) return false;
    this.route(req, path).then(
      ([status, body]) => reply(status, body),
      (e) => {
        if (e instanceof StudioError) {
          const status =
            e.code === 'not_found' ? 404 : e.code === 'not_eligible' || e.code === 'suspended' ? 403 : 409;
          return reply(status, { error: e.code, message: e.message });
        }
        if (e instanceof HttpError) return reply(e.status, { error: e.code, ...e.extra });
        this.o.log?.(`studio api ${req.method} ${path} failed: ${String(e)}`);
        reply(500, { error: 'internal_error' });
      },
    );
    return true;
  }

  private async route(req: IncomingMessage, path: string): Promise<[number, unknown]> {
    const sql = this.o.sql;
    const m = req.method;
    if (m === 'GET' && path === '/api/studio/leaderboard') return [200, await this.leaderboard()];
    if (m === 'GET' && path === '/api/studio/names') {
      const v = new URL(req.url ?? '', 'http://x').searchParams.get('v') ?? '';
      const labels = v
        .split(',')
        .filter((x) => /^studio:\d+:v\d+$/.test(x))
        .slice(0, MAX_NAMES);
      return [200, await studioNames(sql, labels)];
    }

    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const me = token ? await this.o.resolve(token) : null;
    if (!me) throw new HttpError(401, 'invalid_session');

    if (m === 'GET' && path === '/api/studio/agents')
      return [200, { agents: await listMyAgents(sql, me.playerId, this.now()) }];
    if (m === 'POST') this.limit('studioWrite', me.playerId);
    if (m === 'POST' && path === '/api/studio/agents') {
      const body = await readBody(req, StudioCreateRequestSchema);
      this.limit('studioCreate', me.playerId);
      await createStudioAgent(sql, {
        ownerId: me.playerId,
        name: body.name,
        config: body.config,
        now: this.now(),
      });
      return [201, { agents: await listMyAgents(sql, me.playerId, this.now()) }];
    }
    const versions = /^\/api\/studio\/agents\/(\d{1,12})\/versions$/.exec(path);
    if (m === 'POST' && versions) {
      const body = await readBody(req, StudioVersionRequestSchema);
      await saveStudioVersion(sql, {
        ownerId: me.playerId,
        agentId: Number(versions[1]),
        config: body.config,
        now: this.now(),
      });
      return [200, { agents: await listMyAgents(sql, me.playerId, this.now()) }];
    }
    const retire = /^\/api\/studio\/agents\/(\d{1,12})\/retire$/.exec(path);
    if (m === 'POST' && retire) {
      await retireStudioAgent(sql, me.playerId, Number(retire[1]));
      return [200, { agents: await listMyAgents(sql, me.playerId, this.now()) }];
    }
    throw new HttpError(404, 'not_found');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function readBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        if (!parsed.success) return reject(new HttpError(400, 'invalid_request'));
        resolve(parsed.data);
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}
