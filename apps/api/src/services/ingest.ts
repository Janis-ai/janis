import type { IngestEvent, IngestResult } from '@janis/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alertRules,
  alerts,
  conversations,
  messages,
  workspaces,
} from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { notifyWorkspace } from '../lib/notify.js';
import { evaluateEvent } from '../lib/rules.js';
import { mirrorToSlack, postSlackAlert } from '../lib/slack.js';
import { deliverToChannel } from '../lib/channels.js';
import { toAlert, toConversation, toMessage } from '../lib/serializers.js';
import { METER_MESSAGES, reportMeter } from '../lib/stripe.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/**
 * Process a batch of ingest events for one agent.
 * Creates conversations/messages/alerts, updates state, emits SSE + push.
 */
export async function processEvents(
  db: Db,
  agent: AgentRow,
  events: IngestEvent[],
): Promise<IngestResult[]> {
  const rules = await db.select().from(alertRules).where(eq(alertRules.agentId, agent.id));
  const results: IngestResult[] = [];
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agent.id));

  // Stripe customer for metered billing — resolved once per batch
  const [ws] = await db
    .select({ stripeCustomerId: workspaces.stripeCustomerId })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);
  const stripeCustomerId = ws?.stripeCustomerId;

  for (const event of events) {
    const conv = await findOrCreateConversation(db, agent, event);
    const alertIds: string[] = [];

    // Store a message row for events that carry conversational content
    const message = await insertEventMessage(db, conv.id, event);
    if (message) {
      reportMeter(stripeCustomerId, METER_MESSAGES, 1);
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(message) });
      if (message.text) {
        const label = message.direction === 'in' ? ':busts_in_silhouette: *user:*' : ':robot_face: *agent:*';
        void mirrorToSlack(db, conv.id, label, message.text);
        // hosted channels: agent replies go straight to the end user —
        // never internal notes (failures/handoffs/alerts), which are also 'out'
        if (event.type === 'message_out') void deliverToChannel(db, conv.id, message.text);
      }
    }

    // Evaluate alert rules
    for (const triggered of evaluateEvent(event, rules)) {
      const [alert] = await db
        .insert(alerts)
        .values({ conversationId: conv.id, type: triggered.type, detail: triggered.detail })
        .returning();
      alertIds.push(alert.id);
      bus.publish(agent.workspaceId, { type: 'alert', data: toAlert(alert) });
      void postSlackAlert(db, agent.workspaceId, conv, agent, alert);
      void notifyWorkspace(db, agent.workspaceId, {
        title: `Janis: ${triggered.type.replace('_', ' ')}`,
        body: triggered.detail ?? `Conversation ${conv.externalId} needs attention`,
        url: `/conversations/${conv.id}`,
      });
    }

    // State transitions: alerts escalate to needs_human unless a human owns it
    let state = conv.state;
    if (alertIds.length > 0 && state === 'active') state = 'needs_human';
    if (event.type === 'handoff_request' && state === 'active') state = 'needs_human';

    const preview = eventText(event);
    const [updated] = await db
      .update(conversations)
      .set({
        state,
        lastMessageAt: event.timestamp ? new Date(event.timestamp) : new Date(),
        lastMessagePreview: preview?.slice(0, 140) ?? conv.lastMessagePreview,
        lastMessageDirection: directionFor(event),
        // new inbound traffic marks the conversation unread for operators
        isUnread: directionFor(event) === 'in' ? true : conv.isUnread,
        ...(event.user ? { userProfile: event.user } : {}),
      })
      .where(eq(conversations.id, conv.id))
      .returning();

    if (updated.state !== conv.state) {
      bus.publish(agent.workspaceId, {
        type: 'conversation',
        data: { id: updated.id, state: updated.state },
      });
    }

    results.push({
      conversation_id: event.conversation_id,
      paused: updated.state === 'human',
      conversation_state: updated.state,
      alert_ids: alertIds,
    });
  }

  return results;
}

async function findOrCreateConversation(
  db: Db,
  agent: AgentRow,
  event: IngestEvent,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.externalId, event.conversation_id),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      externalId: event.conversation_id,
      userProfile: event.user ?? {},
    })
    .returning();
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: created.id, state: created.state },
  });
  return created;
}

async function insertEventMessage(db: Db, conversationId: string, event: IngestEvent) {
  const row = {
    conversationId,
    text: eventText(event) ?? null,
    payload: ('payload' in event ? event.payload : undefined) ?? {},
    direction: directionFor(event),
    flags: {
      failure: event.type === 'failure',
      help_requested: event.type === 'handoff_request',
      custom_alert: event.type === 'custom_alert',
    },
    ...(event.timestamp ? { createdAt: new Date(event.timestamp) } : {}),
  };
  // message_out / message_in / human-bearing events all produce a message row
  const [message] = await db.insert(messages).values(row).returning();
  return message;
}

function directionFor(event: IngestEvent): 'in' | 'out' | 'human' {
  switch (event.type) {
    case 'message_in':
      return 'in';
    case 'message_out':
      return 'out';
    default:
      // failures/handoffs/alerts are stored as agent-side context notes
      return 'out';
  }
}

function eventText(event: IngestEvent): string | undefined {
  switch (event.type) {
    case 'message_in':
    case 'message_out':
      return event.text;
    case 'failure':
      return event.text ?? event.reason;
    case 'handoff_request':
      return event.reason ? `Handoff requested: ${event.reason}` : 'Handoff requested';
    case 'custom_alert':
      return event.text ?? `Alert: ${event.alert_type}`;
  }
}
