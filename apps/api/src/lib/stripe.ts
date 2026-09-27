import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workspaces } from '../db/schema.js';
import { env } from '../env.js';

let client: Stripe | null = null;

export function stripe(): Stripe | null {
  if (!env.stripeSecret) return null;
  client ??= new Stripe(env.stripeSecret);
  return client;
}

/** Test seam — swap the cached client (e.g. for a fetch-backed client whose
 *  requests vitest can stub; the default NodeHttpClient bypasses fetch). */
export function setStripeClient(c: Stripe | null): void {
  client = c;
}

/** The stored Stripe customer may have been created under the other mode
 *  (test vs live) — verify it exists under the active key, else re-create. */
export async function ensureStripeCustomer(
  s: Stripe,
  db: Db,
  workspaceId: string,
  ws: typeof workspaces.$inferSelect | undefined,
  email: string,
): Promise<string> {
  const existing = ws?.stripeCustomerId;
  if (existing) {
    const found = await s.customers.retrieve(existing).catch(() => null);
    if (found && !(found as { deleted?: boolean }).deleted) return existing;
  }
  const customer = await s.customers.create({
    email,
    name: ws?.name,
    metadata: { workspace_id: workspaceId },
  });
  await db
    .update(workspaces)
    .set({ stripeCustomerId: customer.id })
    .where(eq(workspaces.id, workspaceId));
  return customer.id;
}

/** Stripe price id -> our plan key. */
export function planForPrice(priceId: string): string | null {
  for (const [plan, price] of Object.entries(env.stripePrices)) {
    if (price === priceId) return plan;
  }
  return null;
}

export const METER_MESSAGES = 'janis.messages';
export const METER_LLM_MICROS = 'janis.llm_micros';

/** Fire-and-forget usage report. Never throws — metering must not break
 *  flows. `identifier` dedupes retries and makes the event cancellable via
 *  meter event adjustments (e.g. a mispriced model). */
export function reportMeter(
  customerId: string | null | undefined,
  eventName: string,
  value: number,
  identifier?: string,
): void {
  const s = stripe();
  if (!s || !customerId || value <= 0) return;
  void s.billing.meterEvents
    .create({
      event_name: eventName,
      payload: { stripe_customer_id: customerId, value: String(value) },
      ...(identifier ? { identifier } : {}),
    })
    .catch(() => {});
}
