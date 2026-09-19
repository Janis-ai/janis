import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
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
}

export const PLANS: Record<string, Plan> = {
  free: { name: 'Free', baseCents: 0, includedMessages: 250, overagePer1kCents: null },
  starter: { name: 'Starter', baseCents: 2900, includedMessages: 2_000, overagePer1kCents: 800 },
  pro: { name: 'Pro', baseCents: 9900, includedMessages: 20_000, overagePer1kCents: 500 },
  scale: { name: 'Scale', baseCents: 29900, includedMessages: 100_000, overagePer1kCents: 300 },
};

export function planFor(key: string | null | undefined): Plan {
  return PLANS[key ?? ''] ?? PLANS.free;
}

/** Every stored message counts — user in, agent out, human replies. */
export async function messagesInPeriod(
  db: Db,
  workspaceId: string,
  period = currentPeriod(),
): Promise<number> {
  const start = new Date(`${period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
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

/** Hard cap check — only hard-cap plans (free) ever return capped. */
export async function messageCap(db: Db, workspaceId: string): Promise<CapStatus> {
  const [ws] = await db
    .select({ plan: workspaces.plan, stripeCustomerId: workspaces.stripeCustomerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  let plan = planFor(ws?.plan);
  const used = await messagesInPeriod(db, workspaceId);
  let capped = plan.overagePer1kCents === null && used >= plan.includedMessages;
  if (capped && ws?.stripeCustomerId) {
    const synced = await syncPlanFromStripe(db, workspaceId, ws.stripeCustomerId);
    if (synced) {
      plan = planFor(synced);
      capped = plan.overagePer1kCents === null && used >= plan.includedMessages;
    }
  }
  return { plan, used, capped };
}
