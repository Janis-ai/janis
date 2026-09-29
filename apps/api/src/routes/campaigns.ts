import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaignSends, campaigns, channels } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { dispatchCampaign, resolveSegment } from '../lib/campaigns.js';
import { audit } from '../lib/audit.js';

const createCampaign = z.object({
  channel_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  text: z.string().max(4000).default(''),
  subject: z.string().max(200).optional(),
  whatsapp_template: z
    .object({
      name: z.string().min(1),
      language: z.string().max(20).optional(),
      body_params: z.array(z.string().max(1024)).max(20).optional(),
    })
    .optional(),
  segment: z.object({ q: z.string().max(200).optional() }).optional(),
  /** ISO timestamp — presence schedules; absence leaves a draft. */
  scheduled_at: z.string().datetime().optional(),
});

type SendStatus = { status: string };

function stats(rows: SendStatus[]) {
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    skipped: rows.filter((r) => r.status === 'skipped_opted_out').length,
  };
}

/** Campaigns — scheduled/segmented outbound across a channel's contacts.
 *  Admin-only; bulk outbound is the abuse surface. */
export function campaignRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  app.use('/*', adminOnly);

  app.get('/', async (c) => {
    const rows = await db
      .select({ campaign: campaigns, channelName: channels.name, channelKind: channels.kind })
      .from(campaigns)
      .innerJoin(channels, eq(campaigns.channelId, channels.id))
      .where(eq(campaigns.workspaceId, c.get('workspaceId')))
      .orderBy(desc(campaigns.createdAt))
      .limit(100);
    const withStats = await Promise.all(
      rows.map(async ({ campaign, channelName, channelKind }) => {
        const sends = await db
          .select({ status: campaignSends.status })
          .from(campaignSends)
          .where(eq(campaignSends.campaignId, campaign.id));
        return {
          id: campaign.id,
          name: campaign.name,
          channel_id: campaign.channelId,
          channel_name: channelName,
          channel_kind: channelKind,
          status: campaign.status,
          scheduled_at: campaign.scheduledAt?.toISOString() ?? null,
          created_at: campaign.createdAt.toISOString(),
          stats: stats(sends),
        };
      }),
    );
    return c.json({ campaigns: withStats });
  });

  // Preview a segment before creating — "who would this reach?"
  app.post('/preview', zValidator('json', createCampaign.pick({ channel_id: true, segment: true })), async (c) => {
    const { channel_id, segment } = c.req.valid('json');
    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channel_id), eq(channels.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!ch) return c.json({ error: 'channel not found' }, 404);
    const recipients = await resolveSegment(db, {
      workspaceId: c.get('workspaceId'),
      channelId: channel_id,
      segment: segment ?? {},
    });
    return c.json({
      total: recipients.length,
      opted_out: recipients.filter((r) => r.opted).length,
      sample: recipients.slice(0, 10).map((r) => r.platformUserId),
    });
  });

  app.post('/', zValidator('json', createCampaign), async (c) => {
    const body = c.req.valid('json');
    const workspaceId = c.get('workspaceId');
    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, body.channel_id), eq(channels.workspaceId, workspaceId)))
      .limit(1);
    if (!ch) return c.json({ error: 'channel not found' }, 404);
    if (!['sms', 'whatsapp', 'email', 'gmail', 'outlook'].includes(ch.kind)) {
      return c.json({ error: `${ch.kind} channels can't initiate outbound` }, 400);
    }
    if (ch.kind === 'whatsapp' && !body.whatsapp_template) {
      return c.json({ error: 'whatsapp campaigns require whatsapp_template' }, 400);
    }
    if (!body.text.trim() && !body.whatsapp_template) {
      return c.json({ error: 'text or whatsapp_template required' }, 400);
    }
    const scheduled = body.scheduled_at ? new Date(body.scheduled_at) : null;
    const [row] = await db
      .insert(campaigns)
      .values({
        workspaceId,
        channelId: ch.id,
        name: body.name,
        text: body.text,
        subject: body.subject ?? null,
        template: body.whatsapp_template
          ? {
              name: body.whatsapp_template.name,
              language: body.whatsapp_template.language,
              bodyParams: body.whatsapp_template.body_params,
            }
          : null,
        segment: body.segment ?? {},
        scheduledAt: scheduled,
        status: scheduled ? 'scheduled' : 'draft',
        createdBy: c.get('user').id,
      })
      .returning();
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'campaign.create',
      targetType: 'campaign',
      targetId: row.id,
      meta: { name: body.name, channel_id: ch.id, scheduled: !!scheduled },
    });
    return c.json({ campaign: { id: row.id, status: row.status } }, 201);
  });

  app.get('/:id', async (c) => {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!campaign) return c.json({ error: 'not found' }, 404);
    const sends = await db
      .select()
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id))
      .orderBy(desc(campaignSends.createdAt))
      .limit(500);
    return c.json({
      campaign: {
        id: campaign.id,
        name: campaign.name,
        text: campaign.text,
        channel_id: campaign.channelId,
        status: campaign.status,
        scheduled_at: campaign.scheduledAt?.toISOString() ?? null,
        segment: campaign.segment,
      },
      stats: stats(sends),
      sends: sends.map((s) => ({
        id: s.id,
        recipient: s.recipient,
        status: s.status,
        error: s.error,
        conversation_id: s.conversationId,
        sent_at: s.sentAt?.toISOString() ?? null,
      })),
    });
  });

  // Send now — dispatch immediately rather than waiting on the sweeper.
  app.post('/:id/send', async (c) => {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!campaign) return c.json({ error: 'not found' }, 404);
    if (campaign.status === 'sending' || campaign.status === 'done') {
      return c.json({ error: `campaign already ${campaign.status}` }, 409);
    }
    const queued = await dispatchCampaign(db, campaign.id);
    await db
      .update(campaigns)
      .set({ status: 'sending' })
      .where(eq(campaigns.id, campaign.id));
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'campaign.send',
      targetType: 'campaign',
      targetId: campaign.id,
      meta: { queued },
    });
    return c.json({ queued });
  });

  // Cancel a draft/scheduled campaign before it dispatches.
  app.delete('/:id', async (c) => {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!campaign) return c.json({ error: 'not found' }, 404);
    if (campaign.status === 'sending' || campaign.status === 'done') {
      return c.json({ error: `campaign already ${campaign.status}` }, 409);
    }
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'campaign.delete',
      targetType: 'campaign',
      targetId: campaign.id,
    });
    return c.json({ ok: true });
  });

  return app;
}
