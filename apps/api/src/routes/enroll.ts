import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, contacts } from '../db/schema.js';
import { upsertContactByAddress } from '../lib/contacts.js';
import { enrollContactInCampaign } from '../lib/campaigns.js';
import { dbRateLimit } from '../lib/rateLimit.js';

/** Public campaign-enrollment webhook — POST /enroll/:token. The token is
 *  the credential (generated per campaign); body carries who to enroll.
 *  Deliberately generic in responses — a leaked token shouldn't let anyone
 *  probe whether an address exists in the workspace. */
export function enrollRoutes(db: Db) {
  const app = new Hono();
  app.use(
    '/*',
    dbRateLimit(db, {
      scope: 'enroll-token',
      windowMs: 3_600_000,
      max: 1_000,
      methods: ['POST'],
      key: (c) => c.req.param('token') ?? 'unknown',
    }),
  );

  app.post(
    '/:token',
    zValidator(
      'json',
      z.object({
        email: z.string().email().max(320).optional(),
        phone: z.string().max(40).optional(),
        name: z.string().max(200).optional(),
        external_id: z.object({ system: z.string().max(60), id: z.string().max(200) }).optional(),
        tags: z.array(z.string().max(80)).max(20).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.enrollToken, c.req.param('token')))
        .limit(1);
      if (!campaign || campaign.status !== 'sending') {
        return c.json({ error: 'not found' }, 404);
      }
      if (!body.email && !body.phone && !body.external_id) {
        return c.json({ error: 'email, phone or external_id required' }, 400);
      }
      const { contactId } = await upsertContactByAddress(db, {
        workspaceId: campaign.workspaceId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        external: body.external_id,
        tags: body.tags,
      });
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (!contact) return c.json({ ok: true });
      const result = await enrollContactInCampaign(db, campaign, contact);
      return c.json({ ok: true, enrolled: result === 'queued' });
    },
  );

  return app;
}
