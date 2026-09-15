import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channelBindings, channels, conversations } from '../db/schema.js';
import type { InboundMessage } from '../lib/channels.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { processEvents } from './ingest.js';

type ChannelRow = typeof channels.$inferSelect;

/**
 * Handle an inbound message on a hosted channel:
 *   Meta → binding/conversation → ingest message_in → if the agent still owns
 *   the conversation, forward `message.user` to its webhook so it can reply.
 * While a human owns it (or an alert fired), nothing reaches the agent —
 * gating is enforced at the pipe, not by agent cooperation.
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
    [conv] = await db
      .insert(conversations)
      .values({
        agentId: channel.agentId,
        externalId,
        userProfile: {
          id: msg.senderId,
          ...(msg.name ? { name: msg.name } : {}),
          channel: channel.kind,
        },
      })
      .returning();
    await db.insert(channelBindings).values({
      channelId: channel.id,
      conversationId: conv.id,
      platformUserId: msg.senderId,
    });
  }

  // Store + evaluate rules
  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  if (!agent) return;
  const [result] = await processEvents(db, agent, [
    {
      type: 'message_in',
      conversation_id: externalId,
      text: msg.text,
      user: { id: msg.senderId, name: msg.name },
    },
  ]);

  // Forward to the agent only while it owns the conversation
  if (result?.conversation_state === 'active' && (agent.webhookUrl || agent.hosted)) {
    await deliverWebhook(db, agent, 'message.user', {
      conversation_id: externalId,
      janis_conversation_id: conv.id,
      text: msg.text,
      user: { id: msg.senderId, name: msg.name },
    });
  }
}
