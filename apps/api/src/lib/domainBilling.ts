import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Db } from '../db/client.js';
import { agents, channels, workspaces } from '../db/schema.js';
import { env } from '../env.js';
import { effectivePlanKey } from './plans.js';
import { ensureStripeCustomer, stripe } from './stripe.js';

/** Custom sending domains are plan-gated + an add-on: Pro/Scale include
 *  one, any workspace buys more at DOMAIN_ADDON_USD/domain/mo — the
 *  Resend plan slot is a real cost, so clients fund their own. The price
 *  self-heals via lookup_key so live and test modes need no env wiring. */
export const DOMAIN_ADDON_USD = 5;
const LOOKUP_KEY = 'janis_domain_addon';
const INCLUDED: Record<string, number> = { pro: 1, scale: 1, internal: 99 };

async function domainPrice(s: Stripe): Promise<Stripe.Price> {
  const [found] = (await s.prices.list({ lookup_keys: [LOOKUP_KEY] })).data;
  if (found) return found;
  const product = await s.products.create({
    name: 'Janis custom sending domain',
    metadata: { janis_addon: 'domain' },
  });
  return s.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: DOMAIN_ADDON_USD * 100,
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
  });
}

/** Distinct domains a workspace currently has registered — channels'
 *  credentials plus agents' config.email_sending bags. */
async function domainsInUse(db: Db, workspaceId: string): Promise<Set<string>> {
  const inUse = new Set<string>();
  const [chs, ags] = await Promise.all([
    db
      .select({ credentials: channels.credentials })
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId)),
    db
      .select({ config: agents.config })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId)),
  ]);
  for (const r of chs) {
    const d = (r.credentials as { email_domain?: string }).email_domain;
    if (d) inUse.add(d);
  }
  for (const r of ags) {
    const d = (r.config as { email_sending?: { email_domain?: string } } | null)?.email_sending
      ?.email_domain;
    if (d) inUse.add(d);
  }
  return inUse;
}

async function addonQty(s: Stripe, customerId: string | null): Promise<number> {
  if (!customerId) return 0;
  const subs = await s.subscriptions.list({ customer: customerId, status: 'active' });
  let qty = 0;
  for (const sub of subs.data)
    for (const item of sub.items.data)
      if (item.price.lookup_key === LOOKUP_KEY) qty += item.quantity ?? 1;
  return qty;
}

export interface DomainEntitlement {
  included: number;
  addon: number;
  total: number;
  inUse: string[];
  unitUsd: number;
}

export async function domainEntitlement(db: Db, workspaceId: string): Promise<DomainEntitlement> {
  const [ws] = await db
    .select({ stripeCustomerId: workspaces.stripeCustomerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const plan = await effectivePlanKey(db, workspaceId);
  const included = INCLUDED[plan] ?? 0;
  let addon = 0;
  try {
    const s = stripe();
    if (s) addon = await addonQty(s, ws?.stripeCustomerId ?? null);
  } catch {
    /* Stripe down/missing — count included only; never block on a billing blip */
  }
  return {
    included,
    addon,
    total: included + addon,
    inUse: [...(await domainsInUse(db, workspaceId))],
    unitUsd: DOMAIN_ADDON_USD,
  };
}

/** null → register may proceed; string → 402 with the upsell message. */
export async function checkDomainEntitlement(
  db: Db,
  workspaceId: string,
  domain: string,
): Promise<string | null> {
  if (!env.stripeSecret) return null; // unconfigured billing = self-host; don't gate
  const ent = await domainEntitlement(db, workspaceId);
  if (ent.inUse.includes(domain)) return null; // re-register/adopt — not a new slot
  if (ent.inUse.length < ent.total) return null;
  return ent.included > 0 || ent.addon > 0
    ? `all ${ent.total} custom domain slot(s) in use — add another for $${ent.unitUsd}/mo`
    : `a custom sending domain is a $${ent.unitUsd}/mo add-on on your plan`;
}

/** Purchase one domain slot. Existing plan sub → new prorated item;
 *  no sub → checkout session carrying just the add-on (metadata marks it
 *  so the plan-flip webhooks ignore it — no plan price, no plan). */
export async function purchaseDomainAddon(
  db: Db,
  workspaceId: string,
  userEmail: string,
): Promise<{ added: true } | { url: string }> {
  const s = stripe();
  if (!s) throw new Error('billing not configured');
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const price = await domainPrice(s);
  if (ws?.stripeSubscriptionId) {
    const sub = await s.subscriptions.retrieve(ws.stripeSubscriptionId, { expand: ['items'] });
    const existing = sub.items.data.find((i) => i.price.lookup_key === LOOKUP_KEY);
    await s.subscriptions.update(ws.stripeSubscriptionId, {
      items: existing
        ? [{ id: existing.id, quantity: (existing.quantity ?? 1) + 1 }]
        : [...sub.items.data.map((i) => ({ id: i.id })), { price: price.id, quantity: 1 }],
    });
    return { added: true };
  }
  const customerId = await ensureStripeCustomer(s, db, workspaceId, ws, userEmail);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { workspace_id: workspaceId, addon: 'domain' },
    subscription_data: { metadata: { workspace_id: workspaceId, addon: 'domain' } },
    success_url: `${env.webOrigin}/billing?addon=domain`,
    cancel_url: `${env.webOrigin}/billing`,
  });
  return { url: session.url! };
}
