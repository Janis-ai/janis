import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie } from 'hono/cookie';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channelBindings, errorReports, messages, sessions, workspaces } from '../db/schema.js';
import { SESSION_COOKIE, adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { sha256 } from '../lib/crypto.js';
import { rateLimit } from '../lib/rateLimit.js';
import { notifyWorkspace } from '../lib/notify.js';
import { workspaceMembers } from '../lib/members.js';
import { toMessage } from '../lib/serializers.js';
import { opsAlert } from '../lib/opsAlert.js';
import { bus } from '../lib/bus.js';
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

/** Page the operator when a new report lands — email via notifyWorkspace +
 *  a message in each operator's Ask Janis thread. The workspaces.config
 *  watermark caps alerts at one per cooldown window however noisy the
 *  errors get; the /errors page still collects every report. */
const ALERT_COOLDOWN_MS = 15 * 60_000;

function alertOperatorError(db: Db, report: { source: string; message: string; url: string | null }) {
  if (!env.operatorWorkspaceId) return;
  void (async () => {
    const wsId = env.operatorWorkspaceId;
    const [ws] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .limit(1);
    const cfg = ((ws?.config ?? {}) as Record<string, unknown>) ?? {};
    const last = Date.parse(String(cfg.error_alert_at ?? '')) || 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;
    await db
      .update(workspaces)
      .set({ config: { ...cfg, error_alert_at: new Date().toISOString() } })
      .where(eq(workspaces.id, wsId));

    const summary = `${report.source} error: ${report.message.slice(0, 300)}${
      report.url ? ` — ${report.url}` : ''
    }`;
    await notifyWorkspace(
      db,
      wsId,
      { title: 'Janis error report', body: summary, url: '/errors' },
      { event: 'ops' },
    );
    opsAlert(`[error-report] ${summary}`);

    // Ask Janis rail — operators with an existing concierge thread get the
    // alert as a message from the Janis agent itself.
    if (env.supportChannelId) {
      const members = await workspaceMembers(db, wsId);
      for (const m of members) {
        const [bind] = await db
          .select({ conversationId: channelBindings.conversationId })
          .from(channelBindings)
          .where(
            and(
              eq(channelBindings.channelId, env.supportChannelId),
              eq(channelBindings.platformUserId, `u:${m.user.id}`),
            ),
          )
          .limit(1);
        if (!bind) continue;
        const [msg] = await db
          .insert(messages)
          .values({
            conversationId: bind.conversationId,
            direction: 'out',
            text: `⚠️ New error report — ${summary}\nOpen /errors for the full bundle.`,
            payload: { via: 'ops_alert' },
          })
          .returning();
        bus.publish(wsId, { type: 'message', data: toMessage(msg) });
      }
    }
  })().catch(() => {});
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
      alertOperatorError(db, { source: 'web', message: body.message, url: body.url ?? null });
      return c.json({ id: row.id }, 201);
    },
  );
  return app;
}

/** Server-side counterpart — app.onError calls this fire-and-forget so a
 *  500 lands in the same report list the client errors do. Never throws;
 *  a DB that can't take the insert must not break the error response. */
export function recordApiError(db: Db, err: unknown, c: Parameters<typeof getCookie>[0]) {
  let message = err instanceof Error ? err.message : String(err);
  let stack = err instanceof Error ? err.stack : undefined;
  // drizzle wraps driver failures in "Failed query: …" with the real
  // PostgresError on .cause — fold it in or the report is undiagnosable.
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error) {
    const cMsg = `${cause.name}: ${cause.message}`;
    if (!message.includes(cause.message)) message = `${message}\ncause: ${cMsg}`;
    stack = `${stack ?? ''}\nCaused by: ${cause.stack ?? cMsg}`;
  }
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
    .then(() => alertOperatorError(db, { source: 'api', message: message.slice(0, 300), url: url ?? null }))
    .catch(() => {});
}

/** Operator-only reads — error reports are a Janis developer tool, not a
 *  customer feature. Client workspaces can't list or fetch any report;
 *  the operator workspace sees everything, including anonymous pre-login
 *  crashes nobody else should see. */
export function errorReportRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  app.use('/*', adminOnly);
  app.use('/*', async (c, next) => {
    if (!env.operatorWorkspaceId || c.get('workspaceId') !== env.operatorWorkspaceId) {
      return c.json({ error: 'operator only' }, 403);
    }
    return next();
  });

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
      .orderBy(desc(errorReports.createdAt))
      .limit(100);
    return c.json({ reports: rows });
  });

  /** Download a JSON bundle of every report since the last export — the
   *  cursor lives in workspaces.config so "since last downloaded" is
   *  tracked server-side. `?all=1` ignores the cursor for a full dump. */
  app.get('/export', async (c) => {
    const wsId = c.get('workspaceId');
    const [ws] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .limit(1);
    const cfg = ((ws?.config ?? {}) as Record<string, unknown>) ?? {};
    const sinceParam = c.req.query('since');
    const since = c.req.query('all')
      ? null
      : (sinceParam ?? (cfg.error_export_cursor as string | undefined) ?? null);
    const rows = await db
      .select()
      .from(errorReports)
      .where(since ? gt(errorReports.createdAt, new Date(since)) : undefined)
      .orderBy(errorReports.createdAt);
    if (rows.length) {
      const newest = rows[rows.length - 1].createdAt;
      await db
        .update(workspaces)
        .set({ config: { ...cfg, error_export_cursor: newest.toISOString() } })
        .where(eq(workspaces.id, wsId));
    }
    c.header(
      'content-disposition',
      `attachment; filename="janis-errors-${new Date().toISOString().slice(0, 19)}.json"`,
    );
    return c.json({ exported_at: new Date().toISOString(), since, count: rows.length, reports: rows });
  });

  app.get('/:id', async (c) => {
    const [row] = await db
      .select()
      .from(errorReports)
      .where(eq(errorReports.id, c.req.param('id')))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ report: row });
  });

  return app;
}
