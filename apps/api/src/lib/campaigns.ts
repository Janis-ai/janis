import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  campaignSends,
  campaigns,
  contactIdentities,
  contacts,
  conversations,
  jobs,
  messages,
} from '../db/schema.js';
import { enqueueJob } from './jobs.js';

export interface CampaignSegment {
  /** Free-text match over contact name/email/phone (alts included). */
  q?: string;
  /** Require a reachable email/phone on the contact record. */
  has_email?: boolean;
  has_phone?: boolean;
  /** Contact had conversation activity within this many days. */
  active_within_days?: number;
  /** Contact has never sent an inbound message on any conversation. */
  never_replied?: boolean;
}

/** One drip step — sent delay_minutes after the previous step to recipients
 *  who haven't replied. Replies stop the sequence per-contact. */
export interface CampaignStep {
  delay_minutes: number;
  text?: string;
  subject?: string;
  whatsapp_template?: { name: string; language?: string; body_params?: string[] };
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
  const conds = [
    eq(contacts.workspaceId, campaign.workspaceId),
    eq(contactIdentities.channelId, campaign.channelId),
  ];
  if (q) {
    conds.push(
      or(
        sql`lower(${contacts.name}) like ${`%${q}%`}`,
        sql`lower(${contacts.email}) like ${`%${q}%`}`,
        sql`${contacts.phone} like ${`%${q}%`}`,
        sql`exists (select 1 from unnest(${contacts.altEmails}) e where e ilike ${`%${q}%`})`,
        sql`exists (select 1 from unnest(${contacts.altPhones}) p where p ilike ${`%${q}%`})`,
      )!,
    );
  }
  if (seg.has_email) {
    conds.push(
      sql`(${contacts.email} is not null or cardinality(${contacts.altEmails}) > 0)`,
    );
  }
  if (seg.has_phone) {
    conds.push(
      sql`(${contacts.phone} is not null or cardinality(${contacts.altPhones}) > 0)`,
    );
  }
  if (seg.active_within_days) {
    const cutoff = new Date(Date.now() - seg.active_within_days * 86_400_000);
    conds.push(
      sql`exists (select 1 from ${conversations} cv where cv.contact_id = ${contacts.id} and cv.last_message_at > ${cutoff})`,
    );
  }
  if (seg.never_replied) {
    conds.push(
      sql`not exists (
        select 1 from ${conversations} cv
        join ${messages} m on m.conversation_id = cv.id
        where cv.contact_id = ${contacts.id} and m.direction = 'in'
      )`,
    );
  }
  const rows = await db
    .select({
      contactId: contactIdentities.contactId,
      platformUserId: contactIdentities.platformUserId,
      opted: contactIdentities.optedOutAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contactIdentities.contactId, contacts.id))
    .where(and(...conds));
  return rows.map((r) => ({
    contactId: r.contactId,
    platformUserId: r.platformUserId,
    opted: !!r.opted,
  }));
}

/** One send row per (campaign, step, recipient) — onConflictDoNothing makes
 *  re-dispatch a resume: rows that already exist don't re-enqueue. Returns
 *  the send id when this insert created it, undefined when it was already
 *  there (or would collide). */
async function insertSend(
  db: Db,
  row: {
    campaignId: string;
    workspaceId: string;
    contactId: string;
    channelId: string;
    recipient: string;
    stepIndex: number;
    status: 'pending' | 'skipped_opted_out';
  },
): Promise<string | undefined> {
  const [send] = await db
    .insert(campaignSends)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: campaignSends.id });
  return send?.id;
}

/** A campaign.step job already exists for this step (any status — a failed
 *  one needs inspection, not infinite re-enqueue on every sweep tick). */
async function stepJobExists(db: Db, campaignId: string, stepIndex: number) {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'campaign.step'),
        sql`${jobs.payload}->>'campaignId' = ${campaignId}`,
        sql`(${jobs.payload}->>'stepIndex')::int = ${stepIndex}`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Queue the next drip step, if the campaign has one and it isn't queued. */
async function scheduleStep(db: Db, campaign: typeof campaigns.$inferSelect, stepIndex: number) {
  const steps = (campaign.steps ?? []) as CampaignStep[];
  const step = steps[stepIndex - 1];
  if (!step || await stepJobExists(db, campaign.id, stepIndex)) return;
  await enqueueJob(db, {
    workspaceId: campaign.workspaceId,
    type: 'campaign.step',
    payload: { campaignId: campaign.id, stepIndex },
    runAt: new Date(Date.now() + Math.max(1, step.delay_minutes) * 60_000),
  });
}

/** Fan a due campaign out into campaign_sends + outbound.send jobs.
 *  Called under the sweeper leader lock. Idempotent — the unique
 *  (campaign, step, recipient) key means a crash mid-dispatch resumes by
 *  inserting only the recipients it never reached; re-running is safe and
 *  the 'sending' sweep calls it every tick to gap-fill. */
export async function dispatchCampaign(db: Db, campaignId: string): Promise<number> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign || campaign.status === 'done' || campaign.status === 'failed') return 0;
  const recipients = await resolveSegment(db, campaign);
  const template = (campaign.template ?? undefined) as
    | { name: string; language?: string; bodyParams?: string[] }
    | undefined;
  let queued = 0;
  for (const r of recipients) {
    const sendId = await insertSend(db, {
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      contactId: r.contactId,
      channelId: campaign.channelId,
      recipient: r.platformUserId,
      stepIndex: 0,
      status: r.opted ? 'skipped_opted_out' : 'pending',
    });
    if (!sendId || r.opted) continue;
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
        campaignSendId: sendId,
      },
    });
    queued++;
  }
  await scheduleStep(db, campaign, 1);
  return queued;
}

/** A drip step — sends to prior-step recipients who got the message and
 *  haven't replied since. Job handler for 'campaign.step'. */
export async function dispatchCampaignStep(
  db: Db,
  campaignId: string,
  stepIndex: number,
): Promise<number> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const steps = (campaign?.steps ?? []) as CampaignStep[];
  const step = steps[stepIndex - 1];
  if (!campaign || !step) return 0;
  if (campaign.status === 'failed') return 0;

  const prior = await db
    .select({ contactId: campaignSends.contactId, recipient: campaignSends.recipient })
    .from(campaignSends)
    .where(
      and(
        eq(campaignSends.campaignId, campaign.id),
        eq(campaignSends.stepIndex, stepIndex - 1),
        eq(campaignSends.status, 'sent'),
        // Drip semantics: a reply anywhere in the sequence stops future
        // steps for that contact.
        isNull(campaignSends.repliedAt),
      ),
    );

  let queued = 0;
  for (const r of prior) {
    const sendId = await insertSend(db, {
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      contactId: r.contactId!,
      channelId: campaign.channelId,
      recipient: r.recipient,
      stepIndex,
      status: 'pending',
    });
    if (!sendId) continue;
    const t = step.whatsapp_template;
    await enqueueJob(db, {
      workspaceId: campaign.workspaceId,
      type: 'outbound.send',
      payload: {
        channelId: campaign.channelId,
        to: r.recipient,
        text: step.text ?? campaign.text,
        subject: step.subject ?? campaign.subject ?? undefined,
        template: t
          ? { name: t.name, language: t.language, bodyParams: t.body_params }
          : undefined,
        senderId: campaign.createdBy ?? undefined,
        campaignSendId: sendId,
      },
    });
    queued++;
  }
  await scheduleStep(db, campaign, stepIndex + 1);
  return queued;
}

/** Sweeper hook: dispatch scheduled campaigns whose time has come, gap-fill
 *  'sending' campaigns (idempotent — crash-mid-dispatch resumes), and mark
 *  campaigns done once no pending sends remain. */
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
  const sending = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.status, 'sending'))
    .limit(20);
  for (const c of sending) {
    await dispatchCampaign(db, c.id);
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(and(eq(campaignSends.campaignId, c.id), eq(campaignSends.status, 'pending')));
    if (!pending?.n) {
      await db.update(campaigns).set({ status: 'done' }).where(eq(campaigns.id, c.id));
    }
  }
}

/** Prompt fragment for the reply path: if this conversation originated from
 *  a campaign send, surface the campaign name + the workspace-authored
 *  instructions for how the agent should handle replies. Data-only context
 *  comes from the workspace admin, so it can be phrased as instructions —
 *  but the customer never sees it. */
export async function campaignContextFor(
  db: Db,
  conversationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: campaigns.name, agentInstructions: campaigns.agentInstructions })
    .from(campaignSends)
    .innerJoin(campaigns, eq(campaignSends.campaignId, campaigns.id))
    .where(eq(campaignSends.conversationId, conversationId))
    .limit(1);
  const c = rows[0];
  if (!c) return null;
  const instr = c.agentInstructions?.trim();
  return (
    `\nThis conversation started as an outbound campaign "${c.name}" — ` +
    `the customer is replying to a message you sent them.` +
    (instr ? `\nCampaign instructions for handling replies:\n${instr}` : '')
  );
}
