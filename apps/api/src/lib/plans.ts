import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, shopifyShops, workspaces } from '../db/schema.js';
import { currentPeriod } from './billing.js';
import { planForPrice, stripe } from './stripe.js';

export interface Plan {
  name: string;
  // monthly sell price (USD cents) — includes `includedMessages`
  baseCents: number;
  includedMessages: number;
  // sell price per 1k messages beyond the included amount.
  // null = hard cap (free tier): inbound messages are dropped, not transcribed
  overagePer1kCents: number | null;
  // Shopify rail only: the cappedAmount declared at subscription time — the
  // most a merchant can be charged in usage per 30-day cycle. Unused on the
  // Stripe rail (metered billing has no cap).
  usageCapCents?: number;
  // never offered on the billing page — comped/internal accounts only
  hidden?: boolean;
}

export const PLANS: Record<string, Plan> = {
  free: { name: 'Free', baseCents: 0, includedMessages: 250, overagePer1kCents: null },
  starter: { name: 'Starter', baseCents: 2900, includedMessages: 2_000, overagePer1kCents: 800, usageCapCents: 10_000 },
  pro: { name: 'Pro', baseCents: 9900, includedMessages: 20_000, overagePer1kCents: 500, usageCapCents: 25_000 },
  scale: { name: 'Scale', baseCents: 29900, includedMessages: 100_000, overagePer1kCents: 300, usageCapCents: 60_000 },
  // $0 forever, uncapped — internal accounts. No Stripe price, hidden from checkout.
  internal: {
    name: 'Internal',
    baseCents: 0,
    includedMessages: Number.MAX_SAFE_INTEGER,
    overagePer1kCents: 0,
    hidden: true,
  },
};

export function planFor(key: string | null | undefined): Plan {
  return PLANS[key ?? ''] ?? PLANS.free;
}

/** The plan that actually governs a workspace — agency children without
 *  their own subscription ride on the parent's. */
export async function effectivePlanKey(db: Db, workspaceId: string): Promise<string> {
  const [ws] = await db
    .select({
      plan: workspaces.plan,
      parentWorkspaceId: workspaces.parentWorkspaceId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
      connectSubscriptionId: workspaces.connectSubscriptionId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  // A Connect subscription on the parent's account counts as the child's own
  // plan — the agency is rebilling it, not covering it.
  if (ws?.parentWorkspaceId && !ws.stripeSubscriptionId && !ws.connectSubscriptionId) {
    const [parent] = await db
      .select({ plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, ws.parentWorkspaceId))
      .limit(1);
    return parent?.plan ?? ws.plan;
  }
  return ws?.plan ?? 'free';
}

/** Every stored message counts — user in, agent out, human replies.
 *  `agentId` narrows the count for the agent-scoped usage view. */
export async function messagesInPeriod(
  db: Db,
  workspaceId: string,
  period = currentPeriod(),
  agentId?: string,
): Promise<number> {
  const start = new Date(`${period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return messagesInRange(db, workspaceId, start, end, agentId);
}

/** Same count over explicit bounds — the Shopify billing cycle is 30 days
 *  from activation, not a calendar month. */
export async function messagesInRange(
  db: Db,
  workspaceId: string,
  start: Date,
  end: Date,
  agentId?: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        agentId ? eq(conversations.agentId, agentId) : undefined,
        gte(messages.createdAt, start),
        lt(messages.createdAt, end),
      ),
    );
  return row.count;
}

export interface CapStatus {
  plan: Plan;
  used: number;
  capped: boolean; // hard-capped plan over its included amount
  /** 0..1 fraction of the binding allowance consumed — messages/included for
   *  hard-cap plans, billedCents/usageCap on the Shopify usage rail. */
  fill: number;
  /** Which ceiling binds: 'messages' (free-tier allowance) or 'shopify-usage'
   *  (merchant-approved usage cap). Only set when a real cap applies. */
  capKind?: 'messages' | 'shopify-usage';
  /** Nudge-dedupe key for the current billing window — the calendar month for
   *  message caps, the Shopify cycle's periodEnd for usage caps. */
  period: string;
}

/**
 * Best-effort plan refresh from Stripe — upgrades only. workspaces.plan is a
 * cache filled by webhooks; a missed webhook can leave a paying customer
 * looking 'free'. Called only at the cap boundary, where the stale row would
 * actually drop a paying customer's traffic. Returns the synced plan key.
 */
async function syncPlanFromStripe(
  db: Db,
  workspaceId: string,
  customerId: string,
): Promise<string | null> {
  const s = stripe();
  if (!s) return null;
  const sub = (
    await s.subscriptions.list({ customer: customerId, status: 'active', limit: 1 }).catch(() => null)
  )?.data[0];
  // Check every line item — metered prices can land before the plan base.
  const plan = sub?.items.data.map((i) => planForPrice(i.price.id)).find(Boolean);
  if (!sub || !plan) return null;
  await db
    .update(workspaces)
    .set({ plan, stripeSubscriptionId: sub.id })
    .where(eq(workspaces.id, workspaceId));
  return plan;
}

// Per-message cap checks would otherwise run a COUNT on every inbound —
// the result is cached briefly. A missed webhook/upgrade un-caps within a
// minute; a stale 'capped' for 60s just delays a new customer's reply.
const CAP_CACHE_TTL_MS = 60_000;
const capCache = new Map<string, { status: CapStatus; exp: number }>();

/** Drop a cached cap entry — plan changes (webhooks, admin) un-cap instantly. */
export function invalidateCapCache(workspaceId: string): void {
  capCache.delete(workspaceId);
}

/** Hard cap check — only hard-cap plans (free) ever return capped. */
export async function messageCap(db: Db, workspaceId: string): Promise<CapStatus> {
  const hit = capCache.get(workspaceId);
  if (hit && hit.exp > Date.now()) return hit.status;
  const [ws] = await db
    .select({
      plan: workspaces.plan,
      stripeCustomerId: workspaces.stripeCustomerId,
      parentWorkspaceId: workspaces.parentWorkspaceId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
      connectSubscriptionId: workspaces.connectSubscriptionId,
      billingProvider: workspaces.billingProvider,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  // Agency child: caps/features ride on the parent's plan — flipping the
  // parent flips every child in the same breath. The child's own message
  // count still drives `used`; only the rate card is inherited. A Connect
  // subscription (billed on the agency's account) is the child's own plan.
  let planKey = ws?.plan;
  if (ws?.parentWorkspaceId && !ws?.stripeSubscriptionId && !ws?.connectSubscriptionId) {
    const [parent] = await db
      .select({ plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, ws.parentWorkspaceId))
      .limit(1);
    planKey = parent?.plan ?? planKey;
  }
  let plan = planFor(planKey);
  const used = await messagesInPeriod(db, workspaceId);
  let capped = plan.overagePer1kCents === null && used >= plan.includedMessages;
  if (capped && ws?.stripeCustomerId) {
    const synced = await syncPlanFromStripe(db, workspaceId, ws.stripeCustomerId);
    if (synced) {
      plan = planFor(synced);
      capped = plan.overagePer1kCents === null && used >= plan.includedMessages;
    }
  }
  let fill = plan.includedMessages > 0 ? used / plan.includedMessages : 0;
  let capKind: CapStatus['capKind'] = plan.overagePer1kCents === null ? 'messages' : undefined;
  let period = currentPeriod();
  // Shopify rail: the merchant-approved usage cap is the real ceiling — once
  // appUsageRecordCreate rejects, the latch holds for the rest of the cycle
  // and the agent stops answering (unbilled free service would never end).
  if (ws?.billingProvider === 'shopify' && !capped) {
    const [shop] = await db
      .select({ billing: shopifyShops.billing })
      .from(shopifyShops)
      .where(eq(shopifyShops.workspaceId, workspaceId))
      .limit(1);
    const b = (shop?.billing ?? {}) as {
      usageBilledCents?: number;
      usageCapHit?: string;
      usagePeriodEnd?: string;
    };
    const capCents = plan.usageCapCents ?? 0;
    if (capCents > 0) fill = Math.max(fill, (b.usageBilledCents ?? 0) / capCents);
    // usageCapHit holds the cycle's periodEnd that rejected a record; it stops
    // binding once that period has passed (fresh cap budget each cycle).
    if (b.usageCapHit && b.usagePeriodEnd && new Date(b.usagePeriodEnd) > new Date()) {
      capped = true;
      capKind = 'shopify-usage';
      period = b.usagePeriodEnd;
    }
  }
  const status: CapStatus = { plan, used, capped, fill, capKind, period };
  capCache.set(workspaceId, { status, exp: Date.now() + CAP_CACHE_TTL_MS });
  return status;
}
