import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { agents, conversations } from '../db/schema.js';
import { messages } from '../db/schema.js';
import { env } from '../env.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/**
 * Legacy metered billing — wordhopapi incremented a metered "credits"
 * subscription item after every Dialogflow turn (incrementUsageRecords in
 * messenger.js). The usage-records API predates Billing Meters and is gone
 * from the SDK, so we call the REST endpoint with a pinned API version that
 * still serves these grandfathered subscription items.
 *
 * Plan semantics (from legacy): Pro/ProLight bill once per end-user
 * conversation per billing period (per-user monthly fee); everything else
 * bills per message.
 */
const STRIPE_API = 'https://api.stripe.com/v1';
const LEGACY_API_VERSION = '2020-08-27';
const PER_USER_PLANS = new Set(['ProLight', 'Pro']);

type LegacyStripe = {
  customer_id?: string;
  subscription_id?: string;
  meter_item_id?: string;
  plan?: string;
};

type SubInfo = {
  status: string;
  plan: string;
  meterItemId?: string;
  periodStart?: number;
};

const subCache = new Map<string, { at: number; sub: SubInfo | null }>();
const SUB_TTL_MS = 5 * 60_000;

async function fetchSubscription(subId: string): Promise<SubInfo | null> {
  const hit = subCache.get(subId);
  if (hit && Date.now() - hit.at < SUB_TTL_MS) return hit.sub;
  let sub: SubInfo | null = null;
  try {
    const res = await fetch(`${STRIPE_API}/subscriptions/${subId}`, {
      headers: {
        authorization: `Bearer ${env.stripeSecret}`,
        'stripe-version': LEGACY_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as {
      status?: string;
      plan?: { nickname?: string };
      current_period_start?: number;
      items?: { data?: { id: string; plan?: { usage_type?: string } }[] };
    };
    if (res.ok && j.status) {
      const metered = (j.items?.data ?? []).find((i) => i.plan?.usage_type === 'metered');
      sub = {
        status: j.status,
        plan: j.plan?.nickname ?? '',
        meterItemId: metered?.id,
        periodStart: j.current_period_start,
      };
    }
  } catch {
    sub = null;
  }
  subCache.set(subId, { at: Date.now(), sub });
  return sub;
}

/**
 * Report one handled user turn to the legacy Stripe meter. Fire-and-forget
 * by contract: never throws, never blocks the reply path.
 */
export async function reportLegacyUsage(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
): Promise<void> {
  try {
    if (!env.stripeSecret) return;
    const ls = ((agent.metadata ?? {}) as { legacy_stripe?: LegacyStripe }).legacy_stripe;
    if (!ls?.subscription_id) return;

    const sub = await fetchSubscription(ls.subscription_id);
    const itemId = sub?.meterItemId ?? ls.meter_item_id;
    if (!sub || (sub.status !== 'active' && sub.status !== 'trialing') || !itemId) return;

    const plan = sub.plan || ls.plan || '';
    if (PER_USER_PLANS.has(plan) && sub.periodStart) {
      // One credit per end-user conversation per period — the inbound for
      // this turn is already stored, so >1 means a later turn.
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            eq(messages.direction, 'in'),
            gte(messages.createdAt, new Date(sub.periodStart * 1000)),
          ),
        );
      if (n > 1) return;
    }

    const res = await fetch(`${STRIPE_API}/subscription_items/${itemId}/usage_records`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.stripeSecret}`,
        'stripe-version': LEGACY_API_VERSION,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        quantity: '1',
        action: 'increment',
        timestamp: String(Math.floor(Date.now() / 1000)),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.log(`[legacy-billing] usage record failed ${res.status} sub=${ls.subscription_id}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.log('[legacy-billing] error:', err instanceof Error ? err.message : err);
  }
}
