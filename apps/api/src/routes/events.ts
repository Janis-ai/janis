import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaignSends, conversionEvents } from '../db/schema.js';
import { upsertContactByAddress } from '../lib/contacts.js';
import { queueCrmActivity } from '../lib/crm.js';
import { dbRateLimit } from '../lib/rateLimit.js';

/** Public conversion-event webhook — POST /events/:token. One token per
 *  workspace (workspaces.config.event_token); the credential authorizes
 *  writing a business outcome against a contact. Attributes the event to
 *  the contact's most recent campaign send, so campaign stats distinguish
 *  delivery/reply from actual conversion. Same generic-response policy as
 *  /enroll — no existence probing. */
export function eventRoutes(db: Db) {
  const app = new Hono();
  app.use(
    '/*',
    dbRateLimit(db, {
      scope: 'event-token',
      windowMs: 3_600_000,
      max: 2_000,
      methods: ['POST'],
      key: (c) => c.req.param('token') ?? 'unknown',
    }),
  );

  app.post(
    '/:token',
    zValidator(
      'json',
      z.object({
        event: z.string().min(1).max(80),
        email: z.string().email().max(320).optional(),
        phone: z.string().max(40).optional(),
        external_id: z
          .object({ system: z.string().max(60), id: z.string().max(200) })
          .optional(),
        value_cents: z.number().int().min(0).max(1_000_000_000).optional(),
        source: z.string().max(80).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      // Token lives in workspaces.config.event_token — jsonb lookup.
      const { rows } = await db.execute(
        sql`select id from workspaces where config->>'event_token' = ${c.req.param('token')} limit 1`,
      );
      const found = (rows as unknown as { id: string }[])[0];
      if (!found) return c.json({ error: 'not found' }, 404);
      const workspaceId = found.id;

      if (!body.email && !body.phone && !body.external_id) {
        return c.json({ error: 'email, phone or external_id required' }, 400);
      }
      const { contactId } = await upsertContactByAddress(db, {
        workspaceId,
        email: body.email,
        phone: body.phone,
        external: body.external_id,
      });

      // Attribute to the most recent *sent* campaign send for this contact —
      // last-touch, which is what "the campaign converted them" means here.
      const [send] = await db
        .select()
        .from(campaignSends)
        .where(
          and(
            eq(campaignSends.contactId, contactId),
            eq(campaignSends.workspaceId, workspaceId),
            eq(campaignSends.status, 'sent'),
          ),
        )
        .orderBy(desc(campaignSends.sentAt))
        .limit(1);

      const [evt] = await db
        .insert(conversionEvents)
        .values({
          workspaceId,
          contactId,
          campaignSendId: send?.id ?? null,
          campaignId: send?.campaignId ?? null,
          event: body.event,
          valueCents: body.value_cents ?? null,
          source: body.source ?? 'api',
        })
        .returning();
      if (send && !send.convertedAt) {
        await db
          .update(campaignSends)
          .set({ convertedAt: new Date() })
          .where(eq(campaignSends.id, send.id));
      }
      await queueCrmActivity(db, {
        workspaceId,
        contactId,
        kind: 'conversion',
        refId: evt.id,
        summary: `Conversion: ${body.event}${body.value_cents != null ? ` ($${(body.value_cents / 100).toFixed(2)})` : ''}${body.source ? ` via ${body.source}` : ''}`,
      }).catch(() => {});
      return c.json({ ok: true });
    },
  );

  return app;
}
