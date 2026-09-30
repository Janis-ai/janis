import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  channelBindings,
  conversations,
  messages,
  type channels,
} from '../db/schema.js';
import { sendChannelMessage } from './channels.js';
import { contactForBinding, linkConversationContact } from './contacts.js';
import { isOptedOut } from './optout.js';
import { bus } from './bus.js';
import type { UserProfile } from '@janis/shared';

type ChannelRow = typeof channels.$inferSelect;

export interface OutboundResult {
  conversationId: string | null;
  mid: string | null;
  error: string | null;
}

/** Normalize a recipient for the channel kind; null when the kind can't
 *  initiate outbound at all (Meta reply-window rules, pull-based widget). */
export function normalizeRecipient(
  kind: string,
  raw: string,
): { to: string; profile: Record<string, unknown> } | null {
  const t = raw.trim();
  if (kind === 'sms' || kind === 'whatsapp') {
    const to = `+${t.replace(/[^\d]/g, '')}`;
    if (to.length < 8) return null;
    return { to, profile: { id: to, channel: kind, phone: to } };
  }
  if (kind === 'email' || kind === 'gmail' || kind === 'outlook') {
    const to = t.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return null;
    return { to, profile: { id: to, channel: kind, email: to } };
  }
  return null;
}

/** Find-or-create the conversation for a recipient, deliver the message,
 *  store it, and resolve the contact. Shared by /send and /broadcast. */
export async function sendOutbound(
  db: Db,
  channel: ChannelRow,
  user: { id?: string; name?: string | null } | undefined,
  args: {
    to: string;
    text: string;
    subject?: string;
    template?: { name: string; language?: string; bodyParams?: string[] };
  },
): Promise<OutboundResult> {
  const norm = normalizeRecipient(channel.kind, args.to);
  if (!norm) {
    return {
      conversationId: null,
      mid: null,
      error:
        ['sms', 'whatsapp', 'email', 'gmail', 'outlook'].includes(channel.kind)
          ? 'invalid recipient for this channel'
          : `${channel.kind} channels can't initiate outbound — they can only reply`,
    };
  }
  const { to, profile } = norm;

  // Compliance: an identity that texted STOP refuses outbound on that
  // channel — replies and campaigns both route through here.
  if ((channel.kind === 'sms' || channel.kind === 'whatsapp') && (await isOptedOut(db, channel.id, to))) {
    return { conversationId: null, mid: null, error: 'recipient has opted out (STOP)' };
  }

  const [binding] = await db
    .select({
      conversationId: channelBindings.conversationId,
      contactId: conversations.contactId,
    })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, to),
      ),
    )
    .limit(1);

  // Brand-new WhatsApp thread — Meta only accepts approved templates
  // outside the 24h customer-service window.
  if (channel.kind === 'whatsapp' && !binding && !args.template) {
    return {
      conversationId: null,
      mid: null,
      error: 'new WhatsApp conversations require a template — pass whatsapp_template {name, language, body_params}',
    };
  }
  if (!args.text.trim() && !args.template) {
    return { conversationId: null, mid: null, error: 'text or whatsapp_template required' };
  }

  const workspaceId = channel.workspaceId;
  let conversationId = binding?.conversationId ?? null;
  if (!conversationId) {
    const [conv] = await db
      .insert(conversations)
      .values({
        agentId: channel.agentId,
        externalId: `${channel.kind}:${to}`,
        userProfile: { ...profile, channel_name: channel.name },
      })
      .returning({ id: conversations.id });
    conversationId = conv.id;
    await db
      .insert(channelBindings)
      .values({ channelId: channel.id, conversationId, platformUserId: to });
  }

  const sent = await sendChannelMessage(channel, to, args.text, undefined, {
    senderName: user?.name ?? undefined,
    senderId: user?.id,
    subject: args.subject,
    whatsappTemplate: args.template,
  });
  const error = sent?.error ?? 'channel does not support outbound';

  // Record the attempt either way — a failed send in the inbox is better
  // ops signal than a silent drop.
  await db.insert(messages).values({
    conversationId,
    direction: 'out',
    authorId: user?.id ?? null,
    text: args.text || `[template] ${args.template?.name}`,
    payload: {
      ...(sent?.mid ? { mid: sent.mid } : {}),
      via: 'outbound',
      ...(args.template ? { template: args.template.name } : {}),
    },
    flags: { failure: !!error, help_requested: false, custom_alert: false, handoff_offer: false },
  });
  const preview = (args.text || `[template] ${args.template?.name}`).slice(0, 200);
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastMessagePreview: preview, lastMessageDirection: 'out' })
    .where(eq(conversations.id, conversationId));

  // Contact resolution — same identity spine inbound uses.
  if (!binding?.contactId) {
    const contactId = await contactForBinding(db, {
      workspaceId,
      channelId: channel.id,
      platformUserId: to,
      profile: profile as UserProfile,
    });
    await linkConversationContact(db, conversationId, contactId);
  }

  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: conversationId, state: 'active' },
  });
  return { conversationId, mid: sent?.mid ?? null, error };
}
