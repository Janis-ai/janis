import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages, users } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { mirrorToSlack, setSlackThreadStatus, slackNotice, updateSlackAlert } from '../lib/slack.js';
import { channelBindingFor, deliverToChannel, releaseThreadControl, takeThreadControl, type ChannelDelivery } from '../lib/channels.js';
import { emitChannelUpdate } from '../lib/legacySocket.js';
import { clearAgentWorking, clearOperatorTyping } from '../lib/typingState.js';
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

/** Identity exposed on customer-facing surfaces (agent webhooks — an external
 * agent may render it to end users). display_name wins, else first name; a
 * show_identity opt-out withholds the name entirely. Internal surfaces
 * (console, Slack) keep the real account name. */
function customerOperator(u: UserRow): { id: string; name: string } {
  if (u.showIdentity === false) return { id: u.id, name: 'Operator' };
  return { id: u.id, name: u.displayName || u.name.split(' ')[0] || u.name };
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
    .set({ state: 'human', assigneeId: user.id, humanSince: new Date(), resumeWarnedAt: null, pauseMinutes: null })
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
  // Meta handover protocol: pull the thread so operator sends aren't rejected
  // while another receiver app (Chatfuel/ManyChat) technically holds it.
  void (async () => {
    const b = await channelBindingFor(db, conversationId);
    if (b) await takeThreadControl(b.channel, b.platformUserId);
    // SDK bots learn pause state over their socket; /in responses only
    // carry it lazily on the next inbound message.
    if (b) await emitChannelUpdate(agent, b.platformUserId, true);
  })();
  // Status note in the transcript (internal — never sent to the customer)
  // and in Slack. slackNotice is awaited so a fresh thread row exists before
  // updateSlackAlert tries to restyle it.
  const [note] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'human',
      authorId: user.id,
      text: `${user.name} took over`,
      payload: { internal: true, event: 'takeover' },
    })
    .returning();
  bus.publish(workspaceId, { type: 'message', data: toMessage(note) });
  await slackNotice(db, workspaceId, updated, ':raising_hand:', `_${user.name} took over_`).catch(
    (e) => console.error('slack notice:', e),
  );
  // Refresh the parent alert's buttons even when the action came from the
  // console — otherwise the Slack message keeps offering a stale action.
  void updateSlackAlert(db, workspaceId, updated, agent).catch(() => {});
  await deliverWebhook(db, agent, 'human.takeover', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    operator: customerOperator(user),
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
  slackTs?: string, // originating slack message ts — dedupe key on redelivery
): Promise<{ message: typeof messages.$inferSelect; delivery: ChannelDelivery }> {
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
      payload: {
        ...(attachments?.length ? { attachments } : {}),
        ...(slackTs ? { slack_ts: slackTs } : {}),
      },
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: text.slice(0, 140),
      lastMessageDirection: 'human',
      humanSince: new Date(), // reset auto-resume clock on human activity
    })
    .where(eq(conversations.id, conversationId));

  // A customer-visible reply ends both indicators — the agent's outstanding
  // run is moot and the operator just sent what they were typing.
  clearAgentWorking(conversationId);
  clearOperatorTyping(conversationId);
  void setSlackThreadStatus(db, conversationId, null);
  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  if (!viaSlack) {
    // Slack-side the reply wears the agent's face — the same masquerade the
    // customer sees, matching how the seeded transcript renders operators.
    void mirrorToSlack(db, conversationId, `:bust_in_silhouette: *${agent.name} (operator):*`, text, {
      direction: 'human',
    });
  }
  // If the conv went 'human' without an explicit takeover (DF action, Page
  // Inbox, stop-chat), we may not hold the thread yet — claim it before send.
  // Awaited so the caller learns the real delivery outcome: Meta rejects
  // sends outside the 24h window and the console must not mark those
  // "Delivered".
  const delivery = await (async () => {
    const b = await channelBindingFor(db, conversationId);
    if (b) await takeThreadControl(b.channel, b.platformUserId);
    // Customer-facing identity for the reply: Messenger renders it as a real
    // Persona (name + avatar), text-only channels get an inline name prefix,
    // and show_identity opt-out keeps the reply anonymous everywhere.
    const senderName =
      user.showIdentity === false
        ? undefined
        : user.displayName || user.name.split(' ')[0] || user.name;
    return deliverToChannel(db, conversationId, text, attachments, {
      messageId: message.id,
      senderName,
      senderId: senderName ? user.id : undefined,
      senderAvatar: senderName ? user.avatarUrl : undefined,
    }); // hosted channel: human → end user
  })();
  if (!delivery.delivered) {
    void mirrorToSlack(
      db,
      conversationId,
      ':warning:',
      `_Delivery to the customer failed:_ ${delivery.error ?? 'unknown error'}`,
    );
  }
  await deliverWebhook(db, agent, 'message.human', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    text,
    operator: customerOperator(user),
    payload: attachments?.length ? { attachments } : undefined,
  });
  return { message, delivery };
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
  viaSlack = false,
  slackTs?: string,
): Promise<{ message: typeof messages.$inferSelect; delivery: ChannelDelivery }> {
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
      payload: {
        via: 'operator',
        ...(attachments?.length ? { attachments } : {}),
        ...(slackTs ? { slack_ts: slackTs } : {}),
      },
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: text.slice(0, 140),
      lastMessageDirection: 'out',
      ...(conversation.state === 'human' ? { humanSince: new Date() } : {}), // operator activity resets auto-resume
    })
    .where(eq(conversations.id, conversationId));

  // Same as humanReply — the visitor got a message, so no more dots.
  clearAgentWorking(conversationId);
  clearOperatorTyping(conversationId);
  void setSlackThreadStatus(db, conversationId, null);
  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  if (!viaSlack) {
    void mirrorToSlack(db, conversationId, `:robot_face: *${user.name}* (via agent):`, text, {
      direction: 'out',
    });
  }
  // Awaited so the caller learns the real delivery outcome — same as
  // humanReply; a Meta rejection must surface, not mark "Delivered".
  const delivery = await (async () => {
    const b = await channelBindingFor(db, conversationId);
    if (b) await takeThreadControl(b.channel, b.platformUserId);
    return deliverToChannel(db, conversationId, text, attachments, { messageId: message.id }); // hosted channel: send to end user
  })();
  if (!delivery.delivered) {
    void mirrorToSlack(
      db,
      conversationId,
      ':warning:',
      `_Delivery to the customer failed:_ ${delivery.error ?? 'unknown error'}`,
    );
  }
  await deliverWebhook(db, agent, 'agent.send', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    text,
    operator: customerOperator(user),
    payload: attachments?.length
      ? { via: 'operator', attachments }
      : { via: 'operator' },
  });
  return { message, delivery };
}

/**
 * Internal note — visible to workspace operators (and mirrored into the Slack
 * thread) but never delivered to the end user. This is the operator-to-operator
 * channel: teammates can discuss a live conversation inline. Does NOT reset
 * the auto-resume clock — internal chatter must not hold a takeover open.
 */
export async function internalNote(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow,
  text: string,
  viaSlack = false,
  slackTs?: string,
): Promise<typeof messages.$inferSelect> {
  const { conversation } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state === 'archived') throw new TakeoverError('conversation is archived', 409);

  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'human',
      authorId: user.id,
      text,
      payload: { internal: true, via: viaSlack ? 'slack' : 'web', ...(slackTs ? { slack_ts: slackTs } : {}) },
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      lastMessagePreview: `🔒 ${text.slice(0, 137)}`,
      lastMessageDirection: 'human',
    })
    .where(eq(conversations.id, conversationId));

  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  if (!viaSlack) {
    void mirrorToSlack(db, conversationId, ':lock:', `_${user.name} (internal note):_ ${text}`);
  }
  return message;
}

/**
 * Teach the agent from a conversation thread — appends a fact to the agent's
 * knowledge base and records an auditable internal note. Admin-only (enforced
 * by callers). Returns the new knowledge entry count.
 */
export async function teachAgent(
  db: Db,
  workspaceId: string,
  conversationId: string,
  user: UserRow,
  text: string,
  viaSlack = false,
  slackTs?: string,
): Promise<{ message: typeof messages.$inferSelect; knowledgeCount: number }> {
  const { conversation, agent } = await getConversationForWorkspace(
    db,
    workspaceId,
    conversationId,
  );
  if (conversation.state === 'archived') throw new TakeoverError('conversation is archived', 409);
  const engine = (agent.config as { engine?: string } | null)?.engine;
  if (engine === 'monitor' || engine === 'dialogflow') {
    throw new TakeoverError('teach only applies to hosted agents', 400);
  }

  const cfg = (agent.config ?? {}) as { knowledge?: string[] };
  const knowledge = [...(cfg.knowledge ?? []), text];
  await db
    .update(agents)
    .set({ config: { ...cfg, knowledge } })
    .where(eq(agents.id, agent.id));

  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'human',
      authorId: user.id,
      text: `Taught the agent: ${text}`,
      payload: { internal: true, teach: true, via: viaSlack ? 'slack' : 'web', ...(slackTs ? { slack_ts: slackTs } : {}) },
    })
    .returning();

  bus.publish(workspaceId, { type: 'message', data: toMessage(message) });
  if (!viaSlack) {
    void mirrorToSlack(
      db,
      conversationId,
      ':brain:',
      `_${user.name} taught the agent:_ ${text}`,
    );
  }
  return { message, knowledgeCount: knowledge.length };
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
    .set({ state: 'active', assigneeId: null, humanSince: null, resumeWarnedAt: null, pauseMinutes: null })
    .where(eq(conversations.id, conversationId))
    .returning();

  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: updated.id, state: updated.state },
  });
  // Hand the thread back to the bot platform's receiver app (legacy channels
  // carry secondary_receiver_id); no-op for channels where we're primary.
  void (async () => {
    const b = await channelBindingFor(db, conversationId);
    if (b) await releaseThreadControl(b.channel, b.platformUserId);
    if (b) await emitChannelUpdate(agent, b.platformUserId, false);
  })();
  const [note] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'human',
      authorId: user?.id ?? null,
      text: user ? `${user.name} resumed the agent` : 'auto-resumed to the agent',
      payload: { internal: true, event: 'resume' },
    })
    .returning();
  bus.publish(workspaceId, { type: 'message', data: toMessage(note) });
  await slackNotice(
    db,
    workspaceId,
    updated,
    ':arrow_forward:',
    user ? `_${user.name} resumed the agent_` : '_auto-resumed to the agent_',
  ).catch((e) => console.error('slack notice:', e));
  void updateSlackAlert(db, workspaceId, updated, agent).catch(() => {});
  await deliverWebhook(db, agent, 'human.resume', {
    conversation_id: conversation.externalId,
    janis_conversation_id: conversation.id,
    operator: user ? customerOperator(user) : undefined,
  });
  return updated;
}
