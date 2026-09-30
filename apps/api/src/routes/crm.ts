import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { crmConnections } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { encryptSecret } from '../lib/secrets.js';
import { enqueueJob } from '../lib/jobs.js';
import { syncHubSpotConnection } from '../lib/crm.js';
import { audit } from '../lib/audit.js';

/** CRM read connectors — admin-managed workspace settings. v1 supports
 *  HubSpot private-app tokens; Salesforce lands next via client credentials. */
export function crmRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  app.use('/*', adminOnly);

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(crmConnections)
      .where(eq(crmConnections.workspaceId, c.get('workspaceId')));
    return c.json({
      connections: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        enabled: r.enabled,
        list_id: r.listId,
        watermark: r.watermark?.toISOString() ?? null,
        last_synced_at: r.lastSyncedAt?.toISOString() ?? null,
        last_error: r.lastError,
        synced_count: r.syncedCount,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        provider: z.literal('hubspot'),
        // HubSpot private-app token (pat-na1-…) — static bearer, never leaves
        // the API encrypted.
        token: z.string().min(10).max(500),
      }),
    ),
    async (c) => {
      const { provider, token } = c.req.valid('json');
      // Fail fast on a bad token — verify it can read before storing.
      const probe = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!probe?.ok) {
        return c.json({ error: `HubSpot rejected the token (${probe?.status ?? 'unreachable'})` }, 400);
      }
      const [conn] = await db
        .insert(crmConnections)
        .values({
          workspaceId: c.get('workspaceId'),
          provider,
          credentialsEnc: encryptSecret(JSON.stringify({ token })),
        })
        .returning();
      // First sync kicks off immediately; the job reschedules itself +15min.
      await enqueueJob(db, {
        workspaceId: c.get('workspaceId'),
        type: 'crm.sync',
        payload: { connection_id: conn.id },
      });
      await audit(db, {
        workspaceId: c.get('workspaceId'),
        userId: c.get('user').id,
        userName: c.get('user').name,
        action: 'crm.connect',
        targetType: 'crm_connection',
        targetId: conn.id,
        meta: { provider },
      });
      return c.json({ connection: { id: conn.id, provider } }, 201);
    },
  );

  app.post('/:id/sync-now', async (c) => {
    const [conn] = await db
      .select()
      .from(crmConnections)
      .where(
        and(eq(crmConnections.id, c.req.param('id')), eq(crmConnections.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!conn) return c.json({ error: 'not found' }, 404);
    await enqueueJob(db, {
      workspaceId: conn.workspaceId,
      type: 'crm.sync',
      payload: { connection_id: conn.id },
    });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const [conn] = await db
      .delete(crmConnections)
      .where(
        and(eq(crmConnections.id, c.req.param('id')), eq(crmConnections.workspaceId, c.get('workspaceId'))),
      )
      .returning();
    if (!conn) return c.json({ error: 'not found' }, 404);
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'crm.disconnect',
      targetType: 'crm_connection',
      targetId: conn.id,
    });
    return c.json({ ok: true });
  });

  return app;
}

/** Job handler — loads the connection, runs its provider's sync, reschedules.
 *  Every periodic CRM sync is a self-rescheduling job rather than sweeper
 *  inline work: per-connection failure isolation + backoff for free. */
export async function runCrmSyncJob(db: Db, connectionId: string): Promise<void> {
  const [conn] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.id, connectionId))
    .limit(1);
  if (!conn || !conn.enabled) return;
  try {
    if (conn.provider !== 'hubspot') throw new Error(`unsupported provider ${conn.provider}`);
    await syncHubSpotConnection(db, conn);
  } catch (e) {
    await db
      .update(crmConnections)
      .set({ lastError: (e as Error).message.slice(0, 500), lastSyncedAt: new Date() })
      .where(eq(crmConnections.id, conn.id));
    throw e;
  }
  // Self-reschedule — 15 min cadence, idempotent by watermark.
  await enqueueJob(db, {
    workspaceId: conn.workspaceId,
    type: 'crm.sync',
    payload: { connection_id: conn.id },
    runAt: new Date(Date.now() + 15 * 60_000),
  });
}
