import { and, eq, sql } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import type { ChannelCredentials, InboundMessage } from '../lib/channels.js';
import { resolveGreeting } from '../lib/greeting.js';
import { deliverToChannel, fetchPlatformProfile, sendChannelTyping } from '../lib/channels.js';
import { rehostAttachments } from '../lib/uploads.js';
import { toMessage } from '../lib/serializers.js';
import { bus } from '../lib/bus.js';
import { env } from '../env.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { processEvents } from './ingest.js';

type ChannelRow = typeof channels.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

const PROFILE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Fields we always know from the channel itself. */
function baseProfile(channel: ChannelRow, msg: InboundMessage): UserProfile {
  return {
    id: msg.senderId,
    channel: channel.kind,
    channel_name: channel.name,
    ...(channel.kind === 'whatsapp' ? { phone: msg.senderId } : {}),
    ...(msg.name ? { name: msg.name } : {}),
  };
}

/** Drop undefined/empty values so a sparse fetch never erases known data. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
}

/** Refresh the stored profile when stale — fire-and-forget after ingest. */
async function refreshProfile(
  db: Db,
  channel: ChannelRow,
  conv: ConversationRow,
): Promise<void> {
  const fetched = await fetchPlatformProfile(channel, String((conv.userProfile as UserProfile)?.id ?? ''));
  if (!Object.keys(defined(fetched)).length) return;
  const merged = { ...(conv.userProfile as UserProfile), ...defined(fetched) };
  await db
    .update(conversations)
    .set({ userProfile: merged })
    .where(eq(conversations.id, conv.id));
}

/**
 * Handle an inbound message on a hosted channel:
 *   Meta → binding/conversation → ingest message_in → if the agent still owns
 *   the conversation, forward `message.user` to its webhook so it can reply.
 * needs_human only flags the conversation for attention — the agent keeps
 * replying. Only a human takeover pauses it, enforced at the pipe.
 */
export async function handleChannelMessage(
  db: Db,
  channel: ChannelRow,
  msg: InboundMessage,
): Promise<void> {
  const externalId = `${channel.kind}:${msg.senderId}`;
  const creds = channel.credentials as ChannelCredentials;

  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  if (!agent) return;

  // Find or create the conversation + binding
  const [binding] = await db
    .select({ binding: channelBindings, conversation: conversations })
    .from(channelBindings)
    .innerJoin(conversations, eq(channelBindings.conversationId, conversations.id))
    .where(
      and(
        eq(channelBindings.channelId, channel.id),
        eq(channelBindings.platformUserId, msg.senderId),
      ),
    )
    .limit(1);

  let conv = binding?.conversation;
  if (!conv) {
    // First contact — enrich with the platform profile (name/handle/picture)
    const fetched = await fetchPlatformProfile(channel, msg.senderId);
    const userProfile = { ...baseProfile(channel, msg), ...defined(fetched) };
    [conv] = await db
      .insert(conversations)
      .values({ agentId: channel.agentId, externalId, userProfile })
      .returning();
    await db.insert(channelBindings).values({
      channelId: channel.id,
      conversationId: conv.id,
      platformUserId: msg.senderId,
    });
    // Greeting — a real outbound message stored before the inbound so the
    // transcript opens with it. Null when the agent has greetings disabled.
    // deliverToChannel pushes it on Meta; on webchat the widget renders its
    // own greeting locally and the poll filters this row out.
    const greeting = await resolveGreeting(channel, agent);
    if (greeting) {
      const [note] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: 'out',
          text: greeting,
          payload: { via: 'greeting' },
        })
        .returning();
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
      // Suggested replies ride the greeting on Meta channels — native quick
      // replies on Messenger/IG, interactive buttons on WhatsApp. Channel
      // list overrides the agent's, same as the widget.
      const replies = creds.quick_replies?.length
        ? creds.quick_replies
        : (((agent.config ?? {}) as { quick_replies?: string[] }).quick_replies ?? []);
      void deliverToChannel(db, conv.id, greeting, undefined, { quickReplies: replies });
    }
  } else {
    // Keep WhatsApp names and channel identity current on every message;
    // re-fetch the Meta profile when it's stale (picture URLs expire)
    const profile = (conv.userProfile ?? {}) as UserProfile;
    const updates = defined({ ...baseProfile(channel, msg) });
    const stale =
      !profile.profile_fetched_at ||
      Date.now() - Date.parse(profile.profile_fetched_at) > PROFILE_STALE_MS;
    if (stale && profile.id) {
      void refreshProfile(db, channel, conv).catch(() => {});
    }
    const changed = Object.entries(updates).some(
      ([k, v]) => (profile as Record<string, unknown>)[k] !== v,
    );
    if (changed) {
      await db
        .update(conversations)
        .set({ userProfile: { ...profile, ...updates } })
        .where(eq(conversations.id, conv.id));
      conv = { ...conv, userProfile: { ...profile, ...updates } };
    }
  }

  // Dedup: the same Meta event can reach us twice — once via the direct app
  // webhook and again through the legacy relay — when a page is subscribed
  // to both apps. The platform message id is unique per message.
  if (msg.messageId) {
    const [dup] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.direction, 'in'),
          sql`payload->>'mid' = ${msg.messageId}`,
        ),
      )
      .limit(1);
    if (dup) return;
  }

  const user = defined(conv.userProfile as UserProfile);
  const { picture_url: _pic, ...publicUser } = user; // raw CDN url stays server-side

  // Rehost remote attachment URLs (expiring Meta CDN links, wa-media: refs)
  // into durable /uploads/* rows before they enter the transcript or webhook.
  if (msg.attachments?.length) {
    msg.attachments = await rehostAttachments(db, msg.attachments, creds.access_token);
  }

  // Store + evaluate rules
  const hasFiles = (msg.attachments?.length ?? 0) > 0;
  const [result] = await processEvents(db, agent, [
    {
      type: 'message_in',
      conversation_id: externalId,
      text: msg.text || (msg.attachments ?? []).map((a) => `📎 ${a.name}`).join('\n'),
      payload: {
        ...(msg.messageId ? { mid: msg.messageId } : {}),
        ...(hasFiles ? { attachments: msg.attachments } : {}),
      },
      user: { id: msg.senderId },
    },
  ]);

  // Forward to the agent unless a human owns it — needs_human is just a flag.
  // A capped workspace drops the message before storage (result undefined),
  // but still runs deliverWebhook: its cap check logs the blocked delivery
  // and raises the "cap reached" alert so the operator sees the dropped traffic.
  const state = result?.conversation_state ?? conv.state;
  if (state !== 'human' && state !== 'archived' && (agent.webhookUrl || agent.hosted)) {
    void sendChannelTyping(channel, msg.senderId);
    await deliverWebhook(db, agent, 'message.user', {
      conversation_id: externalId,
      janis_conversation_id: conv.id,
      text: msg.text || (msg.attachments ?? []).map((a) => `📎 ${a.name}`).join('\n'),
      user: publicUser,
      channel: { kind: channel.kind, name: channel.name },
      // External agents get absolute URLs — relative /uploads/* refs only
      // resolve against our own origin (transcript + widget).
      ...(hasFiles
        ? {
            payload: {
              attachments: (msg.attachments ?? []).map((a) => ({
                ...a,
                url: a.url.startsWith('http') ? a.url : `${env.apiOrigin}${a.url}`,
              })),
            },
          }
        : {}),
    });
  }
}
