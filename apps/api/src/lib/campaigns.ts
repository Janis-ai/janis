import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  campaignSends,
  campaigns,
  contactIdentities,
  contacts,
} from '../db/schema.js';
import { enqueueJob } from './jobs.js';

export interface CampaignSegment {
  /** Free-text match over contact name/email/phone. */
  q?: string;
}

/** Resolve a campaign's segment to recipient identities on its channel.
 *  Opted-out identities are returned with opted=true so the caller records
 *  a skipped send (suppression is data, not silence). */
export async function resolveSegment(
  db: Db,
  campaign: { workspaceId: string; channelId: string; segment: unknown },
): Promise<{ contactId: string; platformUserId: string; opted: boolean }[]> {
  const seg = (campaign.segment ?? {}) as CampaignSegment;
  const q = seg.q?.trim().toLowerCase();
  const rows = await db
    .select({
      contactId: contactIdentities.contactId,
      platformUserId: contactIdentities.platformUserId,
      opted: contactIdentities.optedOutAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contactIdentities.contactId, contacts.id))
    .where(
      and(
        eq(contacts.workspaceId, campaign.workspaceId),
        eq(contactIdentities.channelId, campaign.channelId),
        ...(q
          ? [
              or(
                sql`lower(${contacts.name}) like ${`%${q}%`}`,
                sql`lower(${contacts.email}) like ${`%${q}%`}`,
                sql`${contacts.phone} like ${`%${q}%`}`,
              )!,
            ]
          : []),
      ),
    );
  return rows.map((r) => ({
    contactId: r.contactId,
    platformUserId: r.platformUserId,
    opted: !!r.opted,
  }));
}

/** Fan a due campaign out into campaign_sends + outbound.send jobs.
 *  Called under the sweeper leader lock. */
export async function dispatchCampaign(db: Db, campaignId: string): Promise<number> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign || campaign.status === 'done' || campaign.status === 'failed') return 0;
  // Idempotent — a crash mid-dispatch leaves sends rows behind; the next
  // tick must not queue a second blast. Per-recipient resume would need a
  // unique (campaign, recipient) key; v1 treats partial dispatch as done.
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSends)
    .where(eq(campaignSends.campaignId, campaign.id));
  if (existing?.n) return 0;
  const recipients = await resolveSegment(db, campaign);
  const template = (campaign.template ?? undefined) as
    | { name: string; language?: string; bodyParams?: string[] }
    | undefined;
  let queued = 0;
  for (const r of recipients) {
    const [send] = await db
      .insert(campaignSends)
      .values({
        campaignId: campaign.id,
        workspaceId: campaign.workspaceId,
        contactId: r.contactId,
        channelId: campaign.channelId,
        recipient: r.platformUserId,
        status: r.opted ? 'skipped_opted_out' : 'pending',
      })
      .returning({ id: campaignSends.id });
    if (r.opted) continue;
    await enqueueJob(db, {
      workspaceId: campaign.workspaceId,
      type: 'outbound.send',
      payload: {
        channelId: campaign.channelId,
        to: r.platformUserId,
        text: campaign.text,
        subject: campaign.subject ?? undefined,
        template,
        senderId: campaign.createdBy ?? undefined,
        campaignSendId: send.id,
      },
    });
    queued++;
  }
  return queued;
}

/** Sweeper hook: dispatch scheduled campaigns whose time has come, and mark
 *  'sending' campaigns done once no pending sends remain. */
export async function sweepCampaigns(db: Db): Promise<void> {
  const due = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(eq(campaigns.status, 'scheduled'), lte(campaigns.scheduledAt, new Date())),
    )
    .limit(5);
  for (const c of due) {
    await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.id, c.id));
    await dispatchCampaign(db, c.id);
  }
  // sending → done once the last send resolves
  const sending = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.status, 'sending'))
    .limit(20);
  for (const c of sending) {
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(and(eq(campaignSends.campaignId, c.id), eq(campaignSends.status, 'pending')));
    if (!pending?.n) {
      await db.update(campaigns).set({ status: 'done' }).where(eq(campaigns.id, c.id));
    }
  }
}
