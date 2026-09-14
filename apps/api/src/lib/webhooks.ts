import type { OutboundWebhook, OutboundWebhookType } from '@janis/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, webhookDeliveries } from '../db/schema.js';
import { signWebhookPayload } from './crypto.js';

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
  if (!agent.webhookUrl) return;

  const payload: OutboundWebhook = {
    type,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const body = JSON.stringify(payload);

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({ agentId: agent.id, type, payload })
    .returning();

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
