import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  campaignSends,
  campaigns,
  channels,
  contactIdentities,
  contactListMembers,
  contacts,
  conversations,
  jobs,
  messages,
} from '../db/schema.js';
import { enqueueJob } from './jobs.js';

export interface CampaignSegment {
  /** Free-text match over contact name/email/phone (alts included). */
  q?: string;
  /** Static audience — members of this contact_list. */
  list_id?: string;
  /** Any-of tag match on the contact. */
  tags?: string[];
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

/** Email-kinded channels reach contact.email/alt_emails; phone-kinded reach
 *  contact.phone/alt_phones. A contact's addresses ARE its reachable
 *  identities — the channel only decides which one is used, so imported
 *  contacts with no channel history are targetable. */
const EMAIL_KINDS = new Set(['email', 'gmail', 'outlook']);
const PHONE_KINDS = new Set(['sms', 'whatsapp']);

function addressFor(
  kind: string,
  c: { email: string | null; altEmails: string[]; phone: string | null; altPhones: string[] },
): string | null {
  if (EMAIL_KINDS.has(kind)) return c.email ?? c.altEmails[0] ?? null;
  if (PHONE_KINDS.has(kind)) return c.phone ?? c.altPhones[0] ?? null;
  return null;
}

/** Resolve a campaign's segment to recipients reachable on its channel.
 *  Opted-out identities are returned with opted=true so the caller records
 *  a skipped send (suppression is data, not silence); contacts with no
 *  usable address for the channel kind count toward `unreachable`. */
export async function resolveSegment(
  db: Db,
  campaign: { workspaceId: string; channelId: string; segment: unknown },
): Promise<{
  recipients: { contactId: string; platformUserId: string; opted: boolean }[];
  unreachable: number;
}> {
  const seg = (campaign.segment ?? {}) as CampaignSegment;
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, campaign.channelId))
    .limit(1);
  if (!channel) return { recipients: [], unreachable: 0 };
  const needEmail = EMAIL_KINDS.has(channel.kind);
  const needPhone = PHONE_KINDS.has(channel.kind);

  const q = seg.q?.trim().toLowerCase();
  const conds = [eq(contacts.workspaceId, campaign.workspaceId)];
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
  if (seg.list_id) {
    conds.push(
      sql`exists (select 1 from ${contactListMembers} lm where lm.list_id = ${seg.list_id} and lm.contact_id = ${contacts.id})`,
    );
  }
  if (seg.tags?.length) {
    // sql.join — a raw array bind through the template doesn't serialize
    // to a PG array on this driver.
    conds.push(
      sql`exists (select 1 from unnest(${contacts.tags}) t where t in (${sql.join(
        seg.tags.map((t) => sql`${t}`),
        sql`, `,
      )}))`,
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
      id: contacts.id,
      email: contacts.email,
      altEmails: contacts.altEmails,
      phone: contacts.phone,
      altPhones: contacts.altPhones,
    })
    .from(contacts)
    .where(and(...conds))
    .limit(20_000);

  // Map each contact to the address this channel can reach, then look up
  // opt-outs on the (channel, address) pair — suppression still applies to
  // imported contacts who previously STOPped on this channel.
  const addressed = rows
    .map((c) => ({ contactId: c.id, platformUserId: addressFor(channel.kind, c) }))
    .filter((r): r is { contactId: string; platformUserId: string } => !!r.platformUserId);
  const optedSet = new Set<string>();
  if (addressed.length) {
    const optRows = await db
      .select({ platformUserId: contactIdentities.platformUserId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.channelId, campaign.channelId),
          inArray(
            contactIdentities.platformUserId,
            addressed.map((r) => r.platformUserId),
          ),
          sql`${contactIdentities.optedOutAt} is not null`,
        ),
      );
    for (const r of optRows) optedSet.add(r.platformUserId);
  }
  return {
    recipients: addressed.map((r) => ({ ...r, opted: optedSet.has(r.platformUserId) })),
    unreachable: rows.length - addressed.length,
  };
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

/** Insert the send row + queue its outbound job for one recipient.
 *  Returns 'queued' | 'skipped_opted_out' | 'duplicate' (row already
 *  existed — resume/event-enroll re-entry is a no-op). */
async function queueRecipient(
  db: Db,
  campaign: typeof campaigns.$inferSelect,
  r: { contactId: string; platformUserId: string; opted: boolean },
  stepIndex: number,
  content: { text: string; subject?: string | null; template?: { name: string; language?: string; bodyParams?: string[] } },
): Promise<'queued' | 'skipped_opted_out' | 'duplicate'> {
  const sendId = await insertSend(db, {
    campaignId: campaign.id,
    workspaceId: campaign.workspaceId,
    contactId: r.contactId,
    channelId: campaign.channelId,
    recipient: r.platformUserId,
    stepIndex,
    status: r.opted ? 'skipped_opted_out' : 'pending',
  });
  if (!sendId) return 'duplicate';
  if (r.opted) return 'skipped_opted_out';
  await enqueueJob(db, {
    workspaceId: campaign.workspaceId,
    type: 'outbound.send',
    payload: {
      channelId: campaign.channelId,
      to: r.platformUserId,
      text: content.text,
      subject: content.subject ?? undefined,
      template: content.template,
      senderId: campaign.createdBy ?? undefined,
      campaignSendId: sendId,
    },
  });
  return 'queued';
}

/** Fan a due campaign out into campaign_sends + outbound.send jobs.
 *  Called under the sweeper leader lock. Idempotent — the unique
 *  (campaign, step, recipient) key means a crash mid-dispatch resumes by
 *  inserting only the recipients it never reached; re-running is safe and
 *  the 'sending' sweep calls it every tick to gap-fill — which is also how
 *  'continuous' campaigns pick up newly-qualifying contacts. */
export async function dispatchCampaign(db: Db, campaignId: string): Promise<number> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign || campaign.status !== 'sending' && campaign.status !== 'scheduled' && campaign.status !== 'draft') return 0;
  // send_cap = hard ceiling on total send rows (all steps) for the campaign.
  let remaining = Infinity;
  if (campaign.sendCap != null) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id));
    remaining = campaign.sendCap - (row?.n ?? 0);
    if (remaining <= 0) return 0;
  }
  const { recipients } = await resolveSegment(db, campaign);
  const template = (campaign.template ?? undefined) as
    | { name: string; language?: string; bodyParams?: string[] }
    | undefined;
  let queued = 0;
  for (const r of recipients) {
    if (remaining-- <= 0) break;
    if (
      (await queueRecipient(db, campaign, r, 0, {
        text: campaign.text,
        subject: campaign.subject,
        template,
      })) === 'queued'
    ) {
      queued++;
    }
  }
  await scheduleStep(db, campaign, 1);
  return queued;
}

/** Enroll one contact into a campaign — event-driven path (POST /enroll/:token).
 *  The contact must have an address the channel can reach; opted-out
 *  addresses record a skipped send rather than mailing anyway. */
export async function enrollContactInCampaign(
  db: Db,
  campaign: typeof campaigns.$inferSelect,
  contact: {
    id: string;
    email: string | null;
    altEmails: string[];
    phone: string | null;
    altPhones: string[];
  },
): Promise<'queued' | 'skipped_opted_out' | 'duplicate' | 'unreachable'> {
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, campaign.channelId))
    .limit(1);
  if (!channel) return 'unreachable';
  const platformUserId = addressFor(channel.kind, contact);
  if (!platformUserId) return 'unreachable';
  const [optRow] = await db
    .select({ opted: contactIdentities.optedOutAt })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channelId, campaign.channelId),
        eq(contactIdentities.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  return queueRecipient(
    db,
    campaign,
    { contactId: contact.id, platformUserId, opted: !!optRow?.opted },
    0,
    {
      text: campaign.text,
      subject: campaign.subject,
      template: (campaign.template ?? undefined) as
        | { name: string; language?: string; bodyParams?: string[] }
        | undefined,
    },
  );
}

/** A drip step — sends to prior-step recipients who got the message at
 *  least step.delay_minutes ago and haven't replied since. delay is
 *  per-recipient (their prior send time), not wall-clock from dispatch —
 *  that's what makes continuous enrollment drip correctly. Job handler
 *  for 'campaign.step'. */
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
  if (campaign.status !== 'sending') return 0;
  if (campaign.sendCap != null) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaign.id));
    if ((row?.n ?? 0) >= campaign.sendCap) return 0;
  }
  const cutoff = new Date(Date.now() - Math.max(1, step.delay_minutes) * 60_000);

  const prior = await db
    .select({ contactId: campaignSends.contactId, recipient: campaignSends.recipient })
    .from(campaignSends)
    .where(
      and(
        eq(campaignSends.campaignId, campaign.id),
        eq(campaignSends.stepIndex, stepIndex - 1),
        eq(campaignSends.status, 'sent'),
        lte(campaignSends.sentAt, cutoff),
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

/** True when a prior-step send is sent + unreplied but has no step row —
 *  recipients enrolled after the step job ran (continuous campaigns) or
 *  sends that landed after the delay check. The job handler re-enqueues
 *  the step while stragglers exist, so late qualifiers are never dropped. */
export async function stepStragglersExist(
  db: Db,
  campaignId: string,
  stepIndex: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: campaignSends.id })
    .from(campaignSends)
    .where(
      and(
        eq(campaignSends.campaignId, campaignId),
        eq(campaignSends.stepIndex, stepIndex - 1),
        eq(campaignSends.status, 'sent'),
        isNull(campaignSends.repliedAt),
        sql`not exists (
          select 1 from campaign_sends nx
          where nx.campaign_id = ${campaignSends.campaignId}
            and nx.step_index = ${stepIndex}
            and nx.recipient = ${campaignSends.recipient}
        )`,
      ),
    )
    .limit(1);
  return !!row;
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
    .select({ id: campaigns.id, enrollment: campaigns.enrollment })
    .from(campaigns)
    .where(eq(campaigns.status, 'sending'))
    .limit(20);
  for (const c of sending) {
    await dispatchCampaign(db, c.id);
    // 'continuous' campaigns stay in 'sending' — the tick re-resolves the
    // segment and the unique send key makes re-enrollment a no-op, so new
    // qualifying contacts trickle in and old ones never double-send.
    if (c.enrollment === 'continuous') continue;
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
