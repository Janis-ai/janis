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
