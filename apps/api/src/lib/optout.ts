import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  channelBindings,
  contactIdentities,
  conversations,
  messages,
  type channels,
} from '../db/schema.js';
import { contactForBinding, linkConversationContact } from './contacts.js';
import { queueCrmActivity } from './crm.js';
import { audit } from './audit.js';
import { bus } from './bus.js';
import { emitHookEvent } from './hooks.js';
import type { UserProfile } from '@janis/shared';

type ChannelRow = typeof channels.$inferSelect;

/** CTIA keywords — whole-message match only ("stop" inside a sentence is
 *  not an opt-out). STOP-group → suppress; START-group → resubscribe;
 *  HELP → deterministic help reply (no state change). */
const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN = new Set(['start', 'unstop']);
const HELP = new Set(['help']);

export function smsOptKeyword(text: string): 'out' | 'in' | 'help' | null {
  const t = text.trim().toLowerCase().replace(/[.!?\s]+$/, '');
  if (OPT_OUT.has(t)) return 'out';
  if (OPT_IN.has(t)) return 'in';
  if (HELP.has(t)) return 'help';
  return null;
}

/** Double opt-in consent words — the reply a first-time texter gives the
 *  confirm prompt. YES/Y/CONFIRM only; anything else keeps them pending. */
const CONSENT = new Set(['yes', 'y', 'confirm']);

export function smsConsentWord(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?\s]+$/, '');
  return CONSENT.has(t);
}

/** Is this recipient opted out on this channel? sendOutbound refuses when true. */
export async function isOptedOut(
  db: Db,
  channelId: string,
  platformUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ opted: contactIdentities.optedOutAt })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channelId, channelId),
        eq(contactIdentities.platformUserId, platformUserId),
      ),
    )
    .limit(1);
  return !!row?.opted;
}

/** Record an inbound STOP/START without waking the agent: the message lands
 *  in the transcript (flagged), the identity gets its opt flag, no agent
 *  dispatch or webhook fires. Returns false if the text wasn't a keyword. */
export async function applySmsOpt(
  db: Db,
  channel: ChannelRow,
  from: string,
  text: string,
  messageSid?: string,
): Promise<boolean> {
  const kw = smsOptKeyword(text);
  if (!kw) return false;
  const workspaceId = channel.workspaceId;
  const externalId = `sms:${from}`;
  const profile: UserProfile = { id: from, channel: 'sms', phone: from };

  const [existing] = await db
    .select({ conversationId: channelBindings.conversationId })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, from),
      ),
    )
    .limit(1);

  let convId = existing?.conversationId;
  if (!convId) {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: channel.agentId, externalId, userProfile: profile })
      .returning();
    convId = conv.id;
    emitHookEvent(db, channel.agentId, 'new_conversation', conv);
    await db
      .insert(channelBindings)
      .values({ channelId: channel.id, conversationId: convId, platformUserId: from });
  }

  await db.insert(messages).values({
    conversationId: convId,
    direction: 'in',
    text,
    payload: { via: 'sms', opt: kw, ...(messageSid ? { mid: messageSid } : {}) },
    flags: { failure: false, help_requested: false, custom_alert: false, handoff_offer: false },
  });
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 200), lastMessageDirection: 'in' })
    .where(eq(conversations.id, convId));

  const contactId = await contactForBinding(db, {
    workspaceId,
    channelId: channel.id,
    platformUserId: from,
    profile,
  });
  if (contactId) await linkConversationContact(db, convId, contactId);
  if (kw !== 'help') {
    await db
      .update(contactIdentities)
      .set(
        kw === 'out'
          ? { optedOutAt: new Date() }
          : { optedOutAt: null, smsOptedInAt: new Date() }, // START = express consent too
      )
      .where(
        and(
          eq(contactIdentities.channelId, channel.id),
          eq(contactIdentities.platformUserId, from),
        ),
      );
  }
  if (contactId && kw === 'out') {
    void queueCrmActivity(db, {
      workspaceId,
      contactId,
      kind: 'opt_out',
      refId: `${channel.id}:${from}`,
      summary: `Recipient opted out via SMS STOP (${from})`,
    }).catch(() => {});
  }

  if (kw !== 'help') {
    await audit(db, {
      workspaceId,
      action: kw === 'out' ? 'sms.opt_out' : 'sms.opt_in',
      targetType: 'channel',
      targetId: channel.id,
      meta: { recipient: from },
    });
  }
  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: convId, state: 'active' },
  });
  return true;
}

/** A2P double opt-in gate (see /sms-optin.html — the page + campaign
 *  registration promise this flow). First-time texters get a confirm
 *  prompt instead of the agent; their message parks on the conversation
 *  flagged sms_pending until they reply YES, then the agent resumes on
 *  the real transcript. Pass-throughs: identities already consented
 *  (sms_opted_in_at), and pre-gate texters (binding predates the gate —
 *  detected by having NO pending-flagged message).
 *
 *  Returns {handled:false} when the message should reach the agent.
 *  consentedConvId is set when this inbound IS the YES — caller resumes
 *  the agent on that conversation. */
export async function smsConsentGate(
  db: Db,
  channel: ChannelRow,
  from: string,
  text: string,
  messageSid?: string,
): Promise<
  { handled: false } | { handled: true; reply: string | null; consentedConvId?: string }
> {
  const [ident] = await db
    .select({
      optedOutAt: contactIdentities.optedOutAt,
      smsOptedInAt: contactIdentities.smsOptedInAt,
    })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channelId, channel.id),
        eq(contactIdentities.platformUserId, from),
      ),
    )
    .limit(1);
  // Still opted out — silence (START already unblocks via applySmsOpt).
  if (ident?.optedOutAt) return { handled: true, reply: null };

  const [bound] = await db
    .select({ conversationId: channelBindings.conversationId })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, from),
      ),
    )
    .limit(1);

  // Pending = bound conversation holding a parked inbound awaiting YES.
  const pending = bound
    ? !!(await db.execute(
        sql`select 1 from messages where conversation_id = ${bound.conversationId}
            and payload->>'sms_pending' = 'true' limit 1`,
      )).rows.length
    : false;

  // Consented, or a pre-gate texter (bound, never parked) — normal path.
  if (ident?.smsOptedInAt || (bound && !pending)) return { handled: false };

  const profile: UserProfile = { id: from, channel: 'sms', phone: from };
  const workspaceId = channel.workspaceId;

  // This inbound is the YES — record consent, land it on the transcript,
  // and hand the caller the conv to resume (the parked question is the
  // newest non-keyword inbound the agent will answer).
  if (smsConsentWord(text)) {
    const convId = bound?.conversationId ?? (await seedSmsThread(db, channel, from, profile)).convId;
    if (!ident) {
      const contactId = await contactForBinding(db, {
        workspaceId, channelId: channel.id, platformUserId: from, profile,
      });
      if (contactId) await linkConversationContact(db, convId, contactId);
    }
    await db
      .update(contactIdentities)
      .set({ smsOptedInAt: new Date() })
      .where(
        and(
          eq(contactIdentities.channelId, channel.id),
          eq(contactIdentities.platformUserId, from),
        ),
      );
    await recordSmsInbound(db, convId, text, { via: 'sms', opt: 'in', consent: true, ...(messageSid ? { mid: messageSid } : {}) });
    await audit(db, {
      workspaceId,
      action: 'sms.consent',
      targetType: 'channel',
      targetId: channel.id,
      meta: { recipient: from },
    });
    return { handled: true, reply: "You're confirmed — one moment.", consentedConvId: convId };
  }

  // Not consent — park the message and (re)send the confirm prompt.
  const convId = bound?.conversationId ?? (await seedSmsThread(db, channel, from, profile)).convId;
  // MessageSid dedup — a retried webhook must not double-park the text.
  const dupe = messageSid
    ? (await db.execute(
        sql`select 1 from messages where conversation_id = ${convId}
            and payload->>'mid' = ${messageSid} limit 1`,
      )).rows.length
    : 0;
  if (!dupe) {
    await recordSmsInbound(db, convId, text || '(attachment)', {
      via: 'sms', sms_pending: true, ...(messageSid ? { mid: messageSid } : {}),
    });
  }
  return {
    handled: true,
    reply:
      "Thanks for texting us. Reply YES to confirm you'd like SMS replies " +
      '(msg & data rates may apply). Reply STOP anytime to opt out.',
  };
}

async function seedSmsThread(
  db: Db,
  channel: ChannelRow,
  from: string,
  profile: UserProfile,
): Promise<{ convId: string }> {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: channel.agentId, externalId: `sms:${from}`, userProfile: profile })
    .returning();
  emitHookEvent(db, channel.agentId, 'new_conversation', conv);
  await db
    .insert(channelBindings)
    .values({ channelId: channel.id, conversationId: conv.id, platformUserId: from });
  const contactId = await contactForBinding(db, {
    workspaceId: channel.workspaceId, channelId: channel.id, platformUserId: from, profile,
  });
  if (contactId) await linkConversationContact(db, conv.id, contactId);
  return { convId: conv.id };
}

async function recordSmsInbound(
  db: Db,
  convId: string,
  text: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(messages).values({
    conversationId: convId,
    direction: 'in',
    text,
    payload,
    flags: { failure: false, help_requested: false, custom_alert: false, handoff_offer: false },
  });
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 200), lastMessageDirection: 'in' })
    .where(eq(conversations.id, convId));
}
