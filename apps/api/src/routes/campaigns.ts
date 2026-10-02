import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, campaignSends, campaigns, channels, contactLists } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { dispatchCampaign, resolveSegment } from '../lib/campaigns.js';
import { channelReadiness } from '../lib/deliverability.js';
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
  segment: z
    .object({
      q: z.string().max(200).optional(),
      list_id: z.string().uuid().optional(),
      tags: z.array(z.string().max(80)).max(20).optional(),
      has_email: z.boolean().optional(),
      has_phone: z.boolean().optional(),
      active_within_days: z.number().int().min(1).max(365).optional(),
      never_replied: z.boolean().optional(),
    })
    .optional(),
  /** Drip follow-ups — each step reaches prior-step recipients matching
   *  its branch condition (default: haven't replied), delay_minutes after
   *  the previous step. */
  steps: z
    .array(
      z.object({
        delay_minutes: z.number().int().min(1).max(60 * 24 * 30),
        text: z.string().max(4000).optional(),
        subject: z.string().max(200).optional(),
        condition: z
          .enum(['if_not_replied', 'if_replied', 'if_converted', 'if_not_converted', 'always'])
          .optional(),
        whatsapp_template: z
          .object({
            name: z.string().min(1),
            language: z.string().max(20).optional(),
            body_params: z.array(z.string().max(1024)).max(20).optional(),
          })
          .optional(),
      }),
    )
    .max(10)
    .optional(),
  /** Workspace-authored guidance for the channel's agent when it answers
   *  replies to this campaign — injected into the reply prompt for
   *  campaign-originated conversations. */
  agent_instructions: z.string().max(4000).optional(),
  /** 'once' = resolve + finish; 'continuous' = stay active, sweep enrolls
   *  new qualifying contacts each tick + /enroll/:token accepts events. */
  enrollment: z.enum(['once', 'continuous']).optional(),
  /** ISO timestamp — presence schedules; absence leaves a draft. */
  scheduled_at: z.string().datetime().optional(),
  /** Hard ceiling on total sends across all steps — the volume/spend cap. */
  send_cap: z.number().int().min(1).max(1_000_000).optional(),
  /** Business outcome this campaign aims at — matches conversion_events.event. */
  goal: z.string().max(80).optional(),
});

type SendStatus = { status: string; repliedAt?: Date | null; convertedAt?: Date | null };

function stats(rows: SendStatus[]) {
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    replied: rows.filter((r) => r.repliedAt).length,
    failed: rows.filter((r) => r.status === 'failed').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    skipped: rows.filter((r) => r.status.startsWith('skipped_')).length,
    skipped_opted_out: rows.filter((r) => r.status === 'skipped_opted_out').length,
    skipped_suppressed: rows.filter((r) => r.status === 'skipped_suppressed').length,
    skipped_frequency_cap: rows.filter((r) => r.status === 'skipped_frequency_cap').length,
    converted: rows.filter((r) => r.convertedAt).length,
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
      .select({
        campaign: campaigns,
        channelName: channels.name,
        channelKind: channels.kind,
        agentName: agents.name,
      })
      .from(campaigns)
      .innerJoin(channels, eq(campaigns.channelId, channels.id))
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .where(
        and(
          eq(campaigns.workspaceId, c.get('workspaceId')),
          // Agent-scoped view — campaigns send through a channel, and each
          // channel is bound to exactly one agent.
          c.req.query('agent_id') ? eq(channels.agentId, c.req.query('agent_id')!) : undefined,
        ),
      )
      .orderBy(desc(campaigns.createdAt))
      .limit(100);
    const withStats = await Promise.all(
      rows.map(async ({ campaign, channelName, channelKind, agentName }) => {
        const sends = await db
          .select({
            status: campaignSends.status,
            repliedAt: campaignSends.repliedAt,
            convertedAt: campaignSends.convertedAt,
          })
          .from(campaignSends)
          .where(eq(campaignSends.campaignId, campaign.id));
        return {
          id: campaign.id,
          name: campaign.name,
          channel_id: campaign.channelId,
          channel_name: channelName,
          channel_kind: channelKind,
          agent_name: agentName,
          agent_instructions: campaign.agentInstructions,
          enrollment: campaign.enrollment,
          send_cap: campaign.sendCap,
          goal: campaign.goal,
          enroll_token: campaign.enrollToken,
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
    if (segment?.list_id) {
      const [list] = await db
        .select({ id: contactLists.id })
        .from(contactLists)
        .where(and(eq(contactLists.id, segment.list_id), eq(contactLists.workspaceId, c.get('workspaceId'))))
        .limit(1);
      if (!list) return c.json({ error: 'list not found' }, 404);
    }
    const { recipients, unreachable } = await resolveSegment(db, {
      workspaceId: c.get('workspaceId'),
      channelId: channel_id,
      segment: segment ?? {},
    });
    return c.json({
      total: recipients.length,
      opted_out: recipients.filter((r) => r.opted).length,
      unreachable,
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
    if (body.segment?.list_id) {
      const [list] = await db
        .select({ id: contactLists.id })
        .from(contactLists)
        .where(
          and(eq(contactLists.id, body.segment.list_id), eq(contactLists.workspaceId, workspaceId)),
        )
        .limit(1);
      if (!list) return c.json({ error: 'list not found' }, 404);
    }
    if (!['sms', 'whatsapp', 'email', 'gmail', 'outlook'].includes(ch.kind)) {
      return c.json({ error: `${ch.kind} channels can't initiate outbound` }, 400);
    }
    if (ch.kind === 'whatsapp' && !body.whatsapp_template) {
      return c.json({ error: 'whatsapp campaigns require whatsapp_template' }, 400);
    }
    if (!body.text.trim() && !body.whatsapp_template) {
      return c.json({ error: 'text or whatsapp_template required' }, 400);
    }
    for (const [i, s] of (body.steps ?? []).entries()) {
      if (!s.text?.trim() && !s.whatsapp_template) {
        return c.json({ error: `step ${i + 1} needs text or whatsapp_template` }, 400);
      }
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
        steps: body.steps ?? [],
        agentInstructions: body.agent_instructions?.trim() || null,
        enrollment: body.enrollment ?? 'once',
        sendCap: body.send_cap ?? null,
        goal: body.goal?.trim() || null,
        enrollToken: randomBytes(24).toString('base64url'),
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
    const [row] = await db
      .select({
        campaign: campaigns,
        channelName: channels.name,
        channelKind: channels.kind,
        agentName: agents.name,
      })
      .from(campaigns)
      .innerJoin(channels, eq(campaigns.channelId, channels.id))
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .where(
        and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const { campaign, channelName, channelKind, agentName } = row;
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
        subject: campaign.subject,
        whatsapp_template: campaign.template,
        channel_id: campaign.channelId,
        channel_name: channelName,
        channel_kind: channelKind,
        agent_name: agentName,
        status: campaign.status,
        scheduled_at: campaign.scheduledAt?.toISOString() ?? null,
        created_at: campaign.createdAt.toISOString(),
        segment: campaign.segment,
        steps: campaign.steps,
        agent_instructions: campaign.agentInstructions,
        enrollment: campaign.enrollment,
        send_cap: campaign.sendCap,
        goal: campaign.goal,
        enroll_token: campaign.enrollToken,
      },
      stats: stats(sends),
      sends: sends.map((s) => ({
        id: s.id,
        recipient: s.recipient,
        step: s.stepIndex,
        status: s.status,
        error: s.error,
        conversation_id: s.conversationId,
        sent_at: s.sentAt?.toISOString() ?? null,
        replied_at: s.repliedAt ? new Date(s.repliedAt).toISOString() : null,
        converted_at: s.convertedAt ? new Date(s.convertedAt).toISOString() : null,
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
    // Channel-readiness warnings surface AT dispatch — the operator finds out
    // about missing A2P registration or Gmail caps before the blast, not after.
    let warnings: string[] = [];
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, campaign.channelId))
      .limit(1);
    if (channel) {
      warnings = (await channelReadiness(channel, queued)).warnings;
    }
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'campaign.send',
      targetType: 'campaign',
      targetId: campaign.id,
      meta: { queued, warnings },
    });
    return c.json({ queued, warnings });
  });

  /** Shared status-transition helper — pause/resume/cancel are all
   *  lazy at send time: queued jobs re-check campaign status before
   *  dispatching, so no pending-job sweep is needed. */
  const transition = (to: string, from: string[], action: string) =>
    app.post(`/:id/${to}`, async (c) => {
      const workspaceId = c.get('workspaceId');
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, workspaceId)))
        .limit(1);
      if (!campaign) return c.json({ error: 'not found' }, 404);
      if (!from.includes(campaign.status)) {
        return c.json({ error: `can't ${to} a ${campaign.status} campaign` }, 409);
      }
      // Resume a paused-scheduled campaign whose time already passed →
      // straight to 'sending' rather than stuck 'scheduled' in the past.
      const next =
        to === 'cancel'
          ? 'cancelled'
          : to === 'pause'
            ? 'paused'
            : // resume → back to 'scheduled' if its time is still ahead
              campaign.scheduledAt && campaign.scheduledAt > new Date()
              ? 'scheduled'
              : 'sending';
      await db.update(campaigns).set({ status: next }).where(eq(campaigns.id, campaign.id));
      // Cancel skips queued sends eagerly — dispatch jobs would stamp the
      // same status lazily, but operators shouldn't see "pending" forever.
      if (next === 'cancelled') {
        await db
          .update(campaignSends)
          .set({ status: 'skipped_cancelled' })
          .where(
            and(eq(campaignSends.campaignId, campaign.id), eq(campaignSends.status, 'pending')),
          );
      }
      await audit(db, {
        workspaceId,
        userId: c.get('user').id,
        userName: c.get('user').name,
        action,
        targetType: 'campaign',
        targetId: campaign.id,
      });
      return c.json({ ok: true, status: next });
    });
  transition('pause', ['sending', 'scheduled'], 'campaign.pause');
  transition('resume', ['paused'], 'campaign.resume');
  transition('cancel', ['draft', 'scheduled', 'sending', 'paused'], 'campaign.cancel');

  // Delete a campaign and its send history (no FK cascade on
  // campaign_sends). Queued dispatch jobs re-join the send → campaign, so a
  // send whose row is gone no-ops as skipped_cancelled.
  app.delete('/:id', async (c) => {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(
        and(eq(campaigns.id, c.req.param('id')), eq(campaigns.workspaceId, c.get('workspaceId'))),
      )
      .limit(1);
    if (!campaign) return c.json({ error: 'not found' }, 404);
    await db.delete(campaignSends).where(eq(campaignSends.campaignId, campaign.id));
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
