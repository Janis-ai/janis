import { Hono } from 'hono';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, usageEvents, workspaces } from '../db/schema.js';
import { allRates, billingConfig, currentPeriod, rateFor } from '../lib/billing.js';
import { effectivePlanKey, invalidateCapCache, messagesInPeriod, planFor, PLANS } from '../lib/plans.js';
import { planForPrice, stripe } from '../lib/stripe.js';
import { env } from '../env.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

/** The stored Stripe customer may have been created under the other mode
 *  (test vs live) — verify it exists under the active key, else re-create. */
async function ensureStripeCustomer(
  s: NonNullable<ReturnType<typeof stripe>>,
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

export function billingRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/billing/llm-rate?model=x — the cost basis + margin a metered
  // engine bills at, so the Engine tab can show real per-model prices.
  app.get('/llm-rate', (c) => {
    const r = rateFor(c.req.query('model') ?? '');
    return c.json({ input: r.input, output: r.output, margin: billingConfig.margin });
  });

  // GET /api/billing/llm-rates — the whole card + margin, so the model picker
  // can show a billed price per row without a request per model. `plan`
  // tells the picker whether hosted model selection is gated (free plan).
  app.get('/llm-rates', async (c) =>
    c.json({ ...allRates(), plan: await effectivePlanKey(db, c.get('workspaceId')) }),
  );

  // GET /api/billing/summary?period=YYYY-MM — usage + estimated invoice
  app.get('/summary', async (c) => {
    const workspaceId = c.get('workspaceId');
    const period = c.req.query('period') ?? currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: 'period must be YYYY-MM' }, 400);

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

    // Self-heal: if the customer has an active Stripe subscription we never
    // recorded (missed/disabled webhook), sync the plan from the source of
    // truth. Upgrades only — never downgrades on a missed event.
    const s = stripe();
    if (s && ws?.stripeCustomerId) {
      const subs = await s.subscriptions
        .list({ customer: ws.stripeCustomerId, status: 'active', limit: 1 })
        .catch(() => null);
      const sub = subs?.data[0];
      const syncedPlan = sub
        ? (sub.items.data.map((i) => planForPrice(i.price.id)).find(Boolean) ?? '')
        : '';
      if (sub && syncedPlan && (ws.plan !== syncedPlan || ws.stripeSubscriptionId !== sub.id)) {
        await db
          .update(workspaces)
          .set({ plan: syncedPlan, stripeSubscriptionId: sub.id })
          .where(eq(workspaces.id, workspaceId));
        invalidateCapCache(workspaceId);
        ws.plan = syncedPlan;
        ws.stripeSubscriptionId = sub.id;
      }
    }

    // Agency child: report the parent's plan and who to contact for changes.
    let coveredBy: { name?: string; contact?: string } | null = null;
    let planKey = ws?.plan;
    if (ws?.parentWorkspaceId && !ws.stripeSubscriptionId) {
      const [parent] = await db
        .select({ name: workspaces.name, plan: workspaces.plan })
        .from(workspaces)
        .where(eq(workspaces.id, ws.parentWorkspaceId))
        .limit(1);
      planKey = parent?.plan ?? planKey;
      coveredBy = { name: parent?.name, contact: ws.parentContact ?? undefined };
    }
    const plan = planFor(planKey);

    const [llm] = await db
      .select({
        promptTokens: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`,
        events: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.period, period)));

    const byAgent = await db
      .select({
        agentId: usageEvents.agentId,
        agentName: agents.name,
        model: usageEvents.model,
        promptTokens: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`,
        events: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .leftJoin(agents, eq(usageEvents.agentId, agents.id))
      .where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.period, period)))
      .groupBy(usageEvents.agentId, agents.name, usageEvents.model);

    const [{ count: channelCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId));

    const messagesUsed = await messagesInPeriod(db, workspaceId, period);
    const overage = Math.max(0, messagesUsed - plan.includedMessages);
    const overageCents =
      plan.overagePer1kCents === null ? 0 : Math.ceil(overage / 1000) * plan.overagePer1kCents;

    // invoice: plan base + message overage + LLM usage billed (cost + margin,
    // shown as one line). Channels are included in the plan — no per-channel fee.
    const llmBilledCents =
      Math.round((Number(llm.costMicros) / 10_000) * (1 + billingConfig.margin) * 100) / 100;

    return c.json({
      period,
      stripe_enabled: Boolean(env.stripeSecret),
      has_billing_account: Boolean(ws?.stripeCustomerId),
      plans: Object.entries(PLANS)
        .filter(([, p]) => !p.hidden)
        .map(([key, p]) => ({
        key,
        name: p.name,
        base_cents: p.baseCents,
        included_messages: p.includedMessages,
        overage_per_1k_cents: p.overagePer1kCents,
        purchasable: Boolean(env.stripePrices[key]),
      })),
      plan: {
        key: ws?.stripeSubscriptionId ? (ws?.plan ?? 'free') : (planKey ?? 'free'),
        name: plan.name,
        base_cents: plan.baseCents,
        included_messages: plan.includedMessages,
        capped: plan.overagePer1kCents === null,
        covered_by: coveredBy,
      },
      messages: {
        used: messagesUsed,
        included: plan.includedMessages,
        overage,
        overage_cents: overageCents,
      },
      tokens: {
        prompt: llm.promptTokens,
        completion: llm.completionTokens,
        total: llm.promptTokens + llm.completionTokens,
      },
      llm_calls: llm.events,
      channels_connected: channelCount,
      costs: {
        plan_cents: plan.baseCents,
        message_overage_cents: overageCents,
        llm_cents: llmBilledCents,
        margin_pct: billingConfig.margin * 100,
        total_cents: plan.baseCents + overageCents + llmBilledCents,
      },
      by_agent: byAgent.map((r) => ({
        agent_id: r.agentId,
        agent_name: r.agentName ?? '(deleted)',
        model: r.model,
        tokens: r.promptTokens + r.completionTokens,
        llm_calls: r.events,
        cost_cents:
          Math.round((Number(r.costMicros) / 10_000) * (1 + billingConfig.margin) * 100) / 100,
        // Janis-billed calls always price positive — zero cost means the
        // agent ran on the customer's own key.
        byok: r.events > 0 && Number(r.costMicros) === 0,
      })),
    });
  });

  // PATCH /api/billing/plan {plan} — admin-only override (support/dev tool)
  app.patch('/plan', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'admin only' }, 403);
    const { plan } = (await c.req.json()) as { plan?: string };
    if (!plan || !PLANS[plan]) {
      return c.json({ error: `unknown plan — one of ${Object.keys(PLANS).join(', ')}` }, 400);
    }
    await db
      .update(workspaces)
      .set({ plan })
      .where(eq(workspaces.id, c.get('workspaceId')));
    invalidateCapCache(c.get('workspaceId'));
    return c.json({ plan });
  });

  // POST /api/billing/checkout {plan} → Stripe Checkout Session URL
  app.post('/checkout', adminOnly, async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const { plan } = (await c.req.json()) as { plan?: string };
    const priceId = plan ? env.stripePrices[plan] : '';
    if (!plan || !PLANS[plan] || !priceId) {
      return c.json({ error: 'unknown or unavailable plan' }, 400);
    }
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

    const customerId = await ensureStripeCustomer(s, db, workspaceId, ws, c.get('user').email);

    // metered items ride on the same subscription: graduated message overage
    // + LLM pass-through; Stripe computes the bill from reported usage
    const line_items: { price: string; quantity?: number }[] = [{ price: priceId, quantity: 1 }];
    const meterPrice = env.stripeMeterPrices[plan];
    if (meterPrice) line_items.push({ price: meterPrice });
    if (env.stripeMeterPrices.llm) line_items.push({ price: env.stripeMeterPrices.llm });

    const session = await s.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items,
      metadata: { workspace_id: workspaceId, plan },
      subscription_data: { metadata: { workspace_id: workspaceId, plan } },
      success_url: `${env.webOrigin}/billing?upgraded=1`,
      cancel_url: `${env.webOrigin}/billing`,
    });
    return c.json({ url: session.url });
  });

  // POST /api/billing/downgrade — back to free. Cancels the Stripe
  // subscription at period end when one exists (the deleted webhook flips
  // the plan then); workspaces with no subscription flip immediately.
  app.post('/downgrade', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);
    if (ws.plan === 'free') return c.json({ plan: 'free', at_period_end: false });

    if (ws.stripeSubscriptionId) {
      const s = stripe();
      if (s) {
        try {
          await s.subscriptions.update(ws.stripeSubscriptionId, { cancel_at_period_end: true });
          return c.json({ plan: ws.plan, at_period_end: true });
        } catch {
          // subscription is already gone on Stripe's side — flip locally
        }
      }
    }
    await db
      .update(workspaces)
      .set({ plan: 'free', stripeSubscriptionId: null })
      .where(eq(workspaces.id, workspaceId));
    invalidateCapCache(workspaceId);
    return c.json({ plan: 'free', at_period_end: false });
  });

  // POST /api/billing/portal → Stripe Customer Portal URL (cards, invoices, cancel)
  app.post('/portal', adminOnly, async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const customerId = await ensureStripeCustomer(s, db, workspaceId, ws, c.get('user').email);
    const session = await s.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.webOrigin}/billing`,
    });
    return c.json({ url: session.url });
  });

  return app;
}

/**
 * Public Stripe webhook — signature-verified, no session. Mounted at
 * /billing/stripe-webhook (outside /api).
 */
export function stripeWebhookRoutes(db: Db) {
  const app = new Hono();

  app.post('/', async (c) => {
    const s = stripe();
    if (!s || !env.stripeWebhookSecret) return c.json({ error: 'not configured' }, 400);
    const body = await c.req.text();
    let event;
    try {
      event = s.webhooks.constructEvent(
        body,
        c.req.header('stripe-signature') ?? '',
        env.stripeWebhookSecret,
      );
    } catch {
      return c.json({ error: 'bad signature' }, 400);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const wsId = session.metadata?.workspace_id;
      const plan = session.metadata?.plan;
      if (wsId && plan && PLANS[plan]) {
        await db
          .update(workspaces)
          .set({
            plan,
            stripeCustomerId:
              typeof session.customer === 'string' ? session.customer : session.customer?.id,
            stripeSubscriptionId:
              typeof session.subscription === 'string'
                ? session.subscription
                : session.subscription?.id,
          })
          .where(eq(workspaces.id, wsId));
        invalidateCapCache(wsId);
      }
    } else if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated'
    ) {
      const sub = event.data.object;
      const priceId = sub.items.data[0]?.price.id ?? '';
      const plan = planForPrice(priceId);
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (plan) {
        const updated = await db
          .update(workspaces)
          .set({ plan, stripeSubscriptionId: sub.id })
          .where(
            or(
              eq(workspaces.stripeSubscriptionId, sub.id),
              customerId ? eq(workspaces.stripeCustomerId, customerId) : undefined,
            ),
          )
          .returning({ id: workspaces.id });
        for (const ws of updated) invalidateCapCache(ws.id);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      const updated = await db
        .update(workspaces)
        .set({ plan: 'free', stripeSubscriptionId: null })
        .where(
          or(
            eq(workspaces.stripeSubscriptionId, sub.id),
            customerId ? eq(workspaces.stripeCustomerId, customerId) : undefined,
          ),
        )
        .returning({ id: workspaces.id });
      for (const ws of updated) invalidateCapCache(ws.id);
    }

    return c.json({ received: true });
  });

  return app;
}
