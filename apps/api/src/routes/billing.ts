import { Hono } from 'hono';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, usageEvents, workspaces } from '../db/schema.js';
import { billingConfig, currentPeriod } from '../lib/billing.js';
import { messagesInPeriod, planFor, PLANS } from '../lib/plans.js';
import { planForPrice, stripe } from '../lib/stripe.js';
import { env } from '../env.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

export function billingRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/billing/summary?period=YYYY-MM — usage + estimated invoice
  app.get('/summary', async (c) => {
    const workspaceId = c.get('workspaceId');
    const period = c.req.query('period') ?? currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: 'period must be YYYY-MM' }, 400);

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    const plan = planFor(ws?.plan);

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
        promptTokens: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`,
        events: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .leftJoin(agents, eq(usageEvents.agentId, agents.id))
      .where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.period, period)))
      .groupBy(usageEvents.agentId, agents.name);

    const [{ count: channelCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId));

    const messagesUsed = await messagesInPeriod(db, workspaceId, period);
    const overage = Math.max(0, messagesUsed - plan.includedMessages);
    const overageCents =
      plan.overagePer1kCents === null ? 0 : Math.ceil(overage / 1000) * plan.overagePer1kCents;

    // invoice: plan base (sell price) + message overage (sell rate) + channels
    // (sell rate) + LLM pass-through at cost + margin
    const llmCents = Number(llm.costMicros) / 10_000;
    const channelCents = channelCount * billingConfig.channelCents;
    const marginCents = Math.round(llmCents * billingConfig.margin);

    return c.json({
      period,
      stripe_enabled: Boolean(env.stripeSecret),
      plans: Object.entries(PLANS).map(([key, p]) => ({
        key,
        name: p.name,
        base_cents: p.baseCents,
        included_messages: p.includedMessages,
        overage_per_1k_cents: p.overagePer1kCents,
        purchasable: Boolean(env.stripePrices[key]),
      })),
      plan: {
        key: ws?.plan ?? 'free',
        name: plan.name,
        base_cents: plan.baseCents,
        included_messages: plan.includedMessages,
        capped: plan.overagePer1kCents === null,
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
        channel_cents: channelCents,
        llm_cents: Math.round(llmCents * 100) / 100,
        margin_cents: marginCents,
        margin_pct: billingConfig.margin * 100,
        total_cents:
          plan.baseCents + overageCents + channelCents + Math.round(llmCents * 100) / 100 + marginCents,
      },
      by_agent: byAgent.map((r) => ({
        agent_id: r.agentId,
        agent_name: r.agentName ?? '(deleted)',
        tokens: r.promptTokens + r.completionTokens,
        llm_calls: r.events,
        cost_cents: Math.round((Number(r.costMicros) / 10_000) * 100) / 100,
      })),
    });
  });

  // PATCH /api/billing/plan {plan} — admin-only override (support/dev tool)
  app.patch('/plan', async (c) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'admin only' }, 403);
    const { plan } = (await c.req.json()) as { plan?: string };
    if (!plan || !PLANS[plan]) {
      return c.json({ error: `unknown plan — one of ${Object.keys(PLANS).join(', ')}` }, 400);
    }
    await db
      .update(workspaces)
      .set({ plan })
      .where(eq(workspaces.id, c.get('workspaceId')));
    return c.json({ plan });
  });

  // POST /api/billing/checkout {plan} → Stripe Checkout Session URL
  app.post('/checkout', async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const { plan } = (await c.req.json()) as { plan?: string };
    const priceId = plan ? env.stripePrices[plan] : '';
    if (!plan || !PLANS[plan] || !priceId) {
      return c.json({ error: 'unknown or unavailable plan' }, 400);
    }
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

    let customerId = ws?.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await s.customers.create({
        email: c.get('user').email,
        name: ws?.name,
        metadata: { workspace_id: workspaceId },
      });
      customerId = customer.id;
      await db
        .update(workspaces)
        .set({ stripeCustomerId: customerId })
        .where(eq(workspaces.id, workspaceId));
    }

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

  // POST /api/billing/portal → Stripe Customer Portal URL (cards, invoices, cancel)
  app.post('/portal', async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws?.stripeCustomerId) {
      return c.json({ error: 'no billing account yet — pick a plan first' }, 400);
    }
    const session = await s.billingPortal.sessions.create({
      customer: ws.stripeCustomerId,
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
        await db
          .update(workspaces)
          .set({ plan, stripeSubscriptionId: sub.id })
          .where(
            or(
              eq(workspaces.stripeSubscriptionId, sub.id),
              customerId ? eq(workspaces.stripeCustomerId, customerId) : undefined,
            ),
          );
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      await db
        .update(workspaces)
        .set({ plan: 'free', stripeSubscriptionId: null })
        .where(
          or(
            eq(workspaces.stripeSubscriptionId, sub.id),
            customerId ? eq(workspaces.stripeCustomerId, customerId) : undefined,
          ),
        );
    }

    return c.json({ received: true });
  });

  return app;
}
