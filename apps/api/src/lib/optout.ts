import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  channelBindings,
  contactIdentities,
  conversations,
  messages,
  type channels,
} from '../db/schema.js';
import { contactForBinding, linkConversationContact } from './contacts.js';
import { audit } from './audit.js';
import { bus } from './bus.js';
import type { UserProfile } from '@janis/shared';

type ChannelRow = typeof channels.$inferSelect;

/** CTIA keywords — whole-message match only ("stop" inside a sentence is
 *  not an opt-out). STOP-group → suppress; START-group → resubscribe. */
const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN = new Set(['start', 'unstop']);

export function smsOptKeyword(text: string): 'out' | 'in' | null {
  const t = text.trim().toLowerCase().replace(/[.!?\s]+$/, '');
  if (OPT_OUT.has(t)) return 'out';
  if (OPT_IN.has(t)) return 'in';
  return null;
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
      .returning({ id: conversations.id });
    convId = conv.id;
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
  await db
    .update(contactIdentities)
    .set({ optedOutAt: kw === 'out' ? new Date() : null })
    .where(
      and(
        eq(contactIdentities.channelId, channel.id),
        eq(contactIdentities.platformUserId, from),
      ),
    );

  await audit(db, {
    workspaceId,
    action: kw === 'out' ? 'sms.opt_out' : 'sms.opt_in',
    targetType: 'channel',
    targetId: channel.id,
    meta: { recipient: from },
  });
  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: convId, state: 'active' },
  });
  return true;
}
