import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { crmConnections } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { encryptSecret } from '../lib/secrets.js';
import { enqueueJob } from '../lib/jobs.js';
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
        activity_writeback: r.activityWriteback,
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
      z.discriminatedUnion('provider', [
        z.object({
          provider: z.literal('hubspot'),
          // HubSpot private-app token (pat-na1-…) — static bearer, never
          // leaves the API encrypted.
          token: z.string().min(10).max(500),
        }),
        z.object({
          provider: z.literal('salesforce'),
          // Connected-app client_credentials — the API user needs Contact
          // read + Task create scopes on the SF side.
          host: z.string().regex(/^[a-z0-9][a-z0-9.-]+\.(my\.salesforce|lightning\.force|cloudforce)\.com$/, 'must be your my.salesforce.com host').max(200),
          client_id: z.string().min(10).max(200),
          client_secret: z.string().min(10).max(200),
        }),
      ]),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const provider = body.provider;
      // Fail fast on bad creds — verify before storing anything.
      if (provider === 'hubspot') {
        const probe = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
          headers: { Authorization: `Bearer ${body.token}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (!probe?.ok) {
          return c.json({ error: `HubSpot rejected the token (${probe?.status ?? 'unreachable'})` }, 400);
        }
      } else {
        const login = await fetch(`https://${body.host}/services/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: body.client_id,
            client_secret: body.client_secret,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        const data = (await login?.json().catch(() => ({}))) as { access_token?: string };
        if (!login?.ok || !data.access_token) {
          return c.json({ error: `Salesforce rejected the credentials (${login?.status ?? 'unreachable'})` }, 400);
        }
      }
      const credentials =
        provider === 'hubspot'
          ? { token: body.token }
          : { host: body.host, client_id: body.client_id, client_secret: body.client_secret };
      const [conn] = await db
        .insert(crmConnections)
        .values({
          workspaceId: c.get('workspaceId'),
          provider,
          credentialsEnc: encryptSecret(JSON.stringify(credentials)),
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

  // Toggle append-only activity write-back — campaign sends/replies,
  // conversions, human replies and opt-outs become HubSpot notes.
  app.patch(
    '/:id',
    zValidator('json', z.object({ activity_writeback: z.boolean() })),
    async (c) => {
      const { activity_writeback } = c.req.valid('json');
      const [conn] = await db
        .update(crmConnections)
        .set({ activityWriteback: activity_writeback })
        .where(
          and(eq(crmConnections.id, c.req.param('id')), eq(crmConnections.workspaceId, c.get('workspaceId'))),
        )
        .returning();
      if (!conn) return c.json({ error: 'not found' }, 404);
      if (activity_writeback) {
        await enqueueJob(db, {
          workspaceId: conn.workspaceId,
          type: 'crm.writeback',
          payload: { connection_id: conn.id },
        });
      }
      return c.json({ ok: true });
    },
  );

  return app;
}
