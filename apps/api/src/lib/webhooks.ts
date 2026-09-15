import type { OutboundWebhook, OutboundWebhookType } from '@janis/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, webhookDeliveries } from '../db/schema.js';
import { signWebhookPayload } from './crypto.js';
import { runHostedEvent } from './hostedAgent.js';
import { messageCap } from './plans.js';

const RETRY_DELAYS_MS = [0, 1_000, 5_000, 15_000];

type AgentRow = typeof agents.$inferSelect;

/**
 * Deliver a signed webhook to the agent's webhook_url. Fire-and-forget:
 * retries happen in the background and the outcome lands in
 * webhook_deliveries. Never throws.
 */
export async function deliverWebhook(
  db: Db,
  agent: AgentRow,
  type: OutboundWebhookType,
  data: Omit<OutboundWebhook, 'type' | 'timestamp'>,
): Promise<void> {
  if (!agent.hosted && !agent.webhookUrl) return;

  // Hard-capped plan (free tier over its included messages): the bot stops
  // answering but messages still land in the inbox for a human to handle.
  if (type === 'message.user') {
    const cap = await messageCap(db, agent.workspaceId);
    if (cap.capped) {
      const detail = `Message cap reached on ${cap.plan.name} plan (${cap.used}/${cap.plan.includedMessages} this period)`;
      const [delivery] = await db
        .insert(webhookDeliveries)
        .values({ agentId: agent.id, type, payload: { type, ...data } })
        .returning();
      await db
        .update(webhookDeliveries)
        .set({ status: 'failed', attempts: 1, lastError: detail })
        .where(eq(webhookDeliveries.id, delivery.id));
      const convId = (data as { janis_conversation_id?: string }).janis_conversation_id;
      if (convId) {
        const [existing] = await db
          .select({ id: alerts.id })
          .from(alerts)
          .where(
            and(
              eq(alerts.conversationId, convId),
              eq(alerts.type, 'custom'),
              eq(alerts.status, 'open'),
            ),
          )
          .limit(1);
        if (!existing) {
          await db.insert(alerts).values({ conversationId: convId, type: 'custom', detail });
        }
      }
      return;
    }
  }

  const payload: OutboundWebhook = {
    type,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({ agentId: agent.id, type, payload })
    .returning();

  // Hosted agents run in-process — no HTTP round-trip, nothing to sign.
  if (agent.hosted) {
    void (async () => {
      try {
        await runHostedEvent(db, agent, payload);
        await db
          .update(webhookDeliveries)
          .set({ status: 'delivered', attempts: 1 })
          .where(eq(webhookDeliveries.id, delivery.id));
      } catch (err) {
        await db
          .update(webhookDeliveries)
          .set({
            status: 'failed',
            attempts: 1,
            lastError: err instanceof Error ? err.message : String(err),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      }
    })();
    return;
  }

  if (!agent.webhookUrl) return;
  const body = JSON.stringify(payload);
  void attempt(db, delivery.id, agent, body, 0);
}

async function attempt(
  db: Db,
  deliveryId: string,
  agent: AgentRow,
  body: string,
  attemptIndex: number,
): Promise<void> {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'janis-webhooks/0.1',
    };
    if (agent.webhookSecret) {
      headers['x-janis-signature'] = signWebhookPayload(agent.webhookSecret, timestamp, body);
    }

    const res = await fetch(agent.webhookUrl!, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    await db
      .update(webhookDeliveries)
      .set({ status: 'delivered', attempts: attemptIndex + 1 })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextDelay = RETRY_DELAYS_MS[attemptIndex + 1];

    if (nextDelay === undefined) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'failed', attempts: attemptIndex + 1, lastError: message })
        .where(eq(webhookDeliveries.id, deliveryId));
      return;
    }

    await db
      .update(webhookDeliveries)
      .set({ attempts: attemptIndex + 1, lastError: message })
      .where(eq(webhookDeliveries.id, deliveryId));
    setTimeout(() => void attempt(db, deliveryId, agent, body, attemptIndex + 1), nextDelay);
  }
}
