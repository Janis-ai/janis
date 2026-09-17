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
import { enrichHandoff } from '../lib/handoff.js';
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

    // Evaluate alert rules — one open alert per type per conversation, so a
    // struggling agent doesn't spam push/email on every message
    let handoffAlertId: string | undefined;
    let handoffAlertNew = false;
    for (const triggered of evaluateEvent(event, rules)) {
      const [open] = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.conversationId, conv.id),
            eq(alerts.type, triggered.type),
            eq(alerts.status, 'open'),
          ),
        )
        .limit(1);
      if (open) {
        if (triggered.type === 'help_request') {
          handoffAlertId = open.id;
          // Deduped handoffs still reply in the Slack thread — a thread
          // reply, not a new channel post, so it doesn't spam the channel
          void postSlackAlert(db, agent.workspaceId, conv, agent, open);
        }
        continue;
      }
      const [alert] = await db
        .insert(alerts)
        .values({ conversationId: conv.id, type: triggered.type, detail: triggered.detail })
        .returning();
      alertIds.push(alert.id);
      bus.publish(agent.workspaceId, { type: 'alert', data: toAlert(alert) });
      if (triggered.type === 'help_request') {
        // handoff alerts notify after the "what does the customer need"
        // brief is generated — enriched below via enrichHandoff
        handoffAlertId = alert.id;
        handoffAlertNew = true;
        continue;
      }
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
        // Merge, not replace — later events only overwrite the fields they
        // actually carry, so a profile fetched earlier (or an email the
        // customer shared) survives sparse updates
        ...(event.user ? { userProfile: mergeProfile(conv.userProfile, event.user) } : {}),
      })
      .where(eq(conversations.id, conv.id))
      .returning();

    if (updated.state !== conv.state) {
      bus.publish(agent.workspaceId, {
        type: 'conversation',
        data: { id: updated.id, state: updated.state },
      });
    }

    // Enrich every handoff moment with an operator brief — even when the
    // alert was deduped, each note keeps its own summary in the transcript
    if (event.type === 'handoff_request' && message) {
      void enrichHandoff(
        db,
        agent,
        updated,
        message,
        handoffAlertId,
        handoffAlertNew,
        event.reason,
      );
    }

    // Handing off — tell the end user a human is joining. Every request gets
    // a reply until a human actually takes over (needs_human doesn't pause
    // the agent); config.handoff_message overrides, '' disables.
    if (
      event.type === 'handoff_request' &&
      updated.state !== 'human' &&
      updated.state !== 'archived'
    ) {
      const notice = handoffNotice(agent, conv.state === 'needs_human');
      if (notice) {
        const [note] = await db
          .insert(messages)
          .values({
            conversationId: conv.id,
            direction: 'out',
            text: notice,
            payload: { via: 'handoff' },
          })
          .returning();
        bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
        void deliverToChannel(db, conv.id, notice);
      }
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

/** Overlay defined values from `update` onto the stored profile. */
function mergeProfile(
  existing: unknown,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const base = (existing ?? {}) as Record<string, unknown>;
  const defined = Object.fromEntries(
    Object.entries(update).filter(([, v]) => v != null && v !== ''),
  );
  return { ...base, ...defined };
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

function handoffNotice(agent: AgentRow, repeat: boolean): string | null {
  const cfg = (agent.config ?? {}) as {
    handoff_message?: string;
    handoff_repeat_message?: string;
  };
  if (cfg.handoff_message === '') return null; // explicit opt-out
  if (repeat) {
    return (
      cfg.handoff_repeat_message ??
      cfg.handoff_message ??
      'Thanks for bearing with us — a human teammate is still on the way.'
    );
  }
  return (
    cfg.handoff_message ??
    'Thanks for your patience — a human teammate is joining the conversation to help you further.'
  );
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
