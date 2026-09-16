import { and, eq, sql } from 'drizzle-orm';
import type { UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations, messages } from '../db/schema.js';
import type { InboundMessage } from '../lib/channels.js';
import { fetchPlatformProfile } from '../lib/channels.js';
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

  // Store + evaluate rules
  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  if (!agent) return;
  const [result] = await processEvents(db, agent, [
    {
      type: 'message_in',
      conversation_id: externalId,
      text: msg.text,
      payload: msg.messageId ? { mid: msg.messageId } : undefined,
      user: { id: msg.senderId },
    },
  ]);

  // Forward to the agent unless a human owns it — needs_human is just a flag
  if (
    result &&
    result.conversation_state !== 'human' &&
    result.conversation_state !== 'archived' &&
    (agent.webhookUrl || agent.hosted)
  ) {
    await deliverWebhook(db, agent, 'message.user', {
      conversation_id: externalId,
      janis_conversation_id: conv.id,
      text: msg.text,
      user: publicUser,
      channel: { kind: channel.kind, name: channel.name },
    });
  }
}
