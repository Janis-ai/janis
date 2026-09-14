import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages, users } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { mirrorToSlack } from '../lib/slack.js';
import { deliverToChannel } from '../lib/channels.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { toAlert, toMessage } from '../lib/serializers.js';

type UserRow = typeof users.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

export class TakeoverError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export async function getConversationForWorkspace(
  db: Db,
  workspaceId: string,
  conversationId: string,
): Promise<{ conversation: ConversationRow; agent: typeof agents.$inferSelect }> {
  const [row] = await db
    .select({ conversation: conversations, agent: agents })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row || row.agent.workspaceId !== workspaceId) {
    throw new TakeoverError('conversation not found', 404);
  }
  return row;
}

/** Human takes over: conversation → 'human', open alerts resolved, agent notified. */
export async function takeover(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow,
): Promise<ConversationRow> {
  const { conversation, agent } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state === 'archived') throw new TakeoverError('conversation is archived', 409);

  const [updated] = await db
    .update(conversations)
    .set({ state: 'human', assigneeId: user.id, humanSince: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning();

  const openAlerts = await db
    .update(alerts)
    .set({ status: 'resolved' })
    .where(and(eq(alerts.conversationId, conversationId), eq(alerts.status, 'open')))
    .returning();
  for (const a of openAlerts) {
    bus.publish(workspaceId, { type: 'alert', data: toAlert(a) });
  }

  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: updated.id, state: updated.state },
  });
  void mirrorToSlack(db, conversationId, ':raising_hand:', `*${user.name}* took over`);
  await deliverWebhook(db, agent, 'human.takeover', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    operator: { id: user.id, name: user.name },
  });
  return updated;
}

/** Human operator message → stored + relayed to the agent's webhook. */
export async function humanReply(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow,
  text: string,
  attachments?: { name: string; url: string; type: string; size: number }[],
  viaSlack = false,
): Promise<typeof messages.$inferSelect> {
  const { conversation, agent } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state === 'archived') throw new TakeoverError('conversation is archived', 409);
  if (conversation.state !== 'human') {
    throw new TakeoverError('take over the conversation before replying', 409);
  }

  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'human',
      authorId: user.id,
      text,
      payload: attachments?.length ? { attachments } : {},
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: text.slice(0, 140),
      lastMessageDirection: 'human',
    })
    .where(eq(conversations.id, conversationId));

  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  if (!viaSlack) {
    void mirrorToSlack(db, conversationId, `:bust_in_silhouette: *${user.name}:*`, text);
  }
  void deliverToChannel(db, conversationId, text); // hosted channel: human → end user
  await deliverWebhook(db, agent, 'message.human', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    text,
    operator: { id: user.id, name: user.name },
    payload: attachments?.length ? { attachments } : undefined,
  });
  return message;
}

/**
 * "Send via agent" — operator writes text, the agent delivers it to the end
 * user verbatim over its own channel. Stored as an agent-authored message
 * (direction 'out') since that's who the end user sees.
 */
export async function agentSend(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow,
  text: string,
  attachments?: { name: string; url: string; type: string; size: number }[],
): Promise<typeof messages.$inferSelect> {
  const { conversation, agent } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state === 'archived') throw new TakeoverError('conversation is archived', 409);

  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'out',
      authorId: user.id,
      text,
      payload: { via: 'operator', ...(attachments?.length ? { attachments } : {}) },
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: text.slice(0, 140),
      lastMessageDirection: 'out',
    })
    .where(eq(conversations.id, conversationId));

  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  void mirrorToSlack(db, conversationId, `:robot_face: *${user.name}* (via agent):`, text);
  void deliverToChannel(db, conversationId, text); // hosted channel: send to end user
  await deliverWebhook(db, agent, 'agent.send', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    text,
    operator: { id: user.id, name: user.name },
    payload: attachments?.length
      ? { via: 'operator', attachments }
      : { via: 'operator' },
  });
  return message;
}

/** Release back to the agent: conversation → 'active', agent notified. */
export async function resume(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow | null,
): Promise<ConversationRow> {
  const { conversation, agent } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state !== 'human') throw new TakeoverError('conversation is not in human mode', 409);

  const [updated] = await db
    .update(conversations)
    .set({ state: 'active', assigneeId: null, humanSince: null })
    .where(eq(conversations.id, conversationId))
    .returning();

  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: updated.id, state: updated.state },
  });
  void mirrorToSlack(
    db,
    conversationId,
    ':arrow_forward:',
    user ? `*${user.name}* resumed the agent` : 'auto-resumed to the agent',
  );
  await deliverWebhook(db, agent, 'human.resume', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    operator: user ? { id: user.id, name: user.name } : undefined,
  });
  return updated;
}
