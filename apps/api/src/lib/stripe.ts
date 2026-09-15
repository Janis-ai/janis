import Stripe from 'stripe';
import { env } from '../env.js';

let client: Stripe | null = null;

export function stripe(): Stripe | null {
  if (!env.stripeSecret) return null;
  client ??= new Stripe(env.stripeSecret);
  return client;
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

/** Fire-and-forget usage report. Never throws — metering must not break flows. */
export function reportMeter(customerId: string | null | undefined, eventName: string, value: number): void {
  const s = stripe();
  if (!s || !customerId || value <= 0) return;
  void s.billing.meterEvents
    .create({
      event_name: eventName,
      payload: { stripe_customer_id: customerId, value: String(value) },
    })
    .catch(() => {});
}
