import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie } from 'hono/cookie';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { errorReports, sessions } from '../db/schema.js';
import { SESSION_COOKIE, adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { sha256 } from '../lib/crypto.js';
import { rateLimit } from '../lib/rateLimit.js';
import { env } from '../env.js';

/** Caps keep one report bounded — the packet is for an agent to read, and
 *  a megabyte DOM dump defeats the purpose. */
const CAPS = {
  message: 2_000,
  stack: 10_000,
  url: 2_000,
  dom: 200_000,
  screenshot: 600_000, // ~450KB png as base64
};

const reportBody = z.object({
  message: z.string().min(1).max(CAPS.message),
  stack: z.string().max(CAPS.stack).optional(),
  url: z.string().max(CAPS.url).optional(),
  payload: z
    .object({
      route: z.string().max(500).optional(),
      ua: z.string().max(500).optional(),
      dom: z.string().max(CAPS.dom).optional(),
      screenshot: z.string().max(CAPS.screenshot).optional(),
      console_tail: z.array(z.string().max(1_000)).max(60).optional(),
      failed_requests: z
        .array(
          z.object({
            url: z.string().max(500),
            status: z.number().int().optional(),
            error: z.string().max(500).optional(),
            at: z.string().max(50).optional(),
          }),
        )
        .max(20)
        .optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      viewport: z.string().max(50).optional(),
      trigger: z.string().max(50).optional(),
    })
    .optional(),
});

/** Resolve the session cookie when present — pre-login errors still post,
 *  just unattributed. */
async function sessionFor(db: Db, c: Parameters<typeof getCookie>[0]) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await db
    .select({ userId: sessions.userId, workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/** The public ingest endpoint — mounted unauthenticated because errors
 *  happen on the login page too. Rate-limited per IP. */
export function errorReportIngest(db: Db) {
  const app = new Hono();
  app.post(
    '/',
    rateLimit({ scope: 'error-report', windowMs: 60_000, max: 20 }),
    zValidator('json', reportBody),
    async (c) => {
      const body = c.req.valid('json');
      const sess = await sessionFor(db, c).catch(() => null);
      const [row] = await db
        .insert(errorReports)
        .values({
          workspaceId: sess?.workspaceId ?? null,
          userId: sess?.userId ?? null,
          source: 'web',
          message: body.message,
          stack: body.stack ?? null,
          url: body.url ?? null,
          payload: body.payload ?? {},
        })
        .returning({ id: errorReports.id });
      return c.json({ id: row.id }, 201);
    },
  );
  return app;
}

/** Server-side counterpart — app.onError calls this fire-and-forget so a
 *  500 lands in the same report list the client errors do. Never throws;
 *  a DB that can't take the insert must not break the error response. */
export function recordApiError(db: Db, err: unknown, c: Parameters<typeof getCookie>[0]) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const url = (c as { req?: { url?: string } }).req?.url;
  void sessionFor(db, c)
    .catch(() => null)
    .then((sess) =>
      db.insert(errorReports).values({
        workspaceId: sess?.workspaceId ?? null,
        userId: sess?.userId ?? null,
        source: 'api',
        message: message.slice(0, CAPS.message),
        stack: stack?.slice(0, CAPS.stack) ?? null,
        url: url?.slice(0, CAPS.url) ?? null,
        payload: { ua: (c as { req?: { header?(n: string): string | undefined } }).req?.header?.('user-agent') },
      }),
    )
    .catch(() => {});
}

/** Admin reads — own workspace's reports, plus anonymous ones when the
 *  caller is the operator workspace (nobody else should see a logged-out
 *  visitor's page DOM). */
export function errorReportRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  app.use('/*', adminOnly);

  const scope = (workspaceId: string) =>
    workspaceId === env.operatorWorkspaceId
      ? or(eq(errorReports.workspaceId, workspaceId), isNull(errorReports.workspaceId))
      : eq(errorReports.workspaceId, workspaceId);

  app.get('/', async (c) => {
    const rows = await db
      .select({
        id: errorReports.id,
        source: errorReports.source,
        message: errorReports.message,
        url: errorReports.url,
        createdAt: errorReports.createdAt,
        hasScreenshot: sql<boolean>`(${errorReports.payload}->>'screenshot') is not null`,
        route: sql<string | null>`${errorReports.payload}->>'route'`,
      })
      .from(errorReports)
      .where(scope(c.get('workspaceId')))
      .orderBy(desc(errorReports.createdAt))
      .limit(100);
    return c.json({ reports: rows });
  });

  app.get('/:id', async (c) => {
    const [row] = await db
      .select()
      .from(errorReports)
      .where(and(eq(errorReports.id, c.req.param('id')), scope(c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ report: row });
  });

  return app;
}
