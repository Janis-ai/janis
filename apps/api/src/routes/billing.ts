import { Hono } from 'hono';
import Stripe from 'stripe';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, usageEvents, workspaces } from '../db/schema.js';
import { allRates, billingConfig, currentPeriod, rateFor } from '../lib/billing.js';
import { effectivePlanKey, invalidateCapCache, messagesInPeriod, planFor, PLANS } from '../lib/plans.js';
import { ensureStripeCustomer, planForPrice, stripe } from '../lib/stripe.js';
import { env } from '../env.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { audit } from '../lib/audit.js';
import { bus } from '../lib/bus.js';

// Every plan write must do both: drop the message-cap memo and notify
// open consoles — plan-gated UI (Settings, Help custom domain, usage)
// otherwise shows the old plan until the next page load.
const planChanged = (wsId: string) => {
  invalidateCapCache(wsId);
  bus.publish(wsId, { type: 'workspace', data: { id: wsId } });
};

export function billingRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  // Hono compose() routes handler throws to the app's onError (middleware
  // try/catch can't intercept), and route() honors a sub-app's onError — so
  // this does fire for Stripe failures. Their messages are user-actionable
  // (e.g. Connect platform-profile prompts); surface them as 502s.
  app.onError((err, c) => {
    console.error('billing route error:', err);
    if (err instanceof Stripe.errors.StripeError) {
      return c.json({ error: err.message }, 502);
    }
    return c.json({ error: 'Internal server error' }, 500);
  });
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

  // GET /api/billing/status — cheap sidebar meter: plan + messages used vs
  // included. No Stripe sync (unlike /summary) so it's safe to poll.
  app.get('/status', async (c) => {
    const ws = c.get('workspaceId');
    const [planKey, used] = await Promise.all([
      effectivePlanKey(db, ws),
      messagesInPeriod(db, ws),
    ]);
    const plan = planFor(planKey);
    return c.json({
      plan_key: planKey,
      plan_name: plan.name,
      used,
      included: plan.includedMessages,
      pct: plan.includedMessages ? Math.min(100, Math.round((used / plan.includedMessages) * 100)) : 0,
      capped: plan.overagePer1kCents === null,
    });
  });

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
        planChanged(workspaceId);
        ws.plan = syncedPlan;
        ws.stripeSubscriptionId = sub.id;
      }
    }

    // Agency child: report the parent's plan and who to contact for changes.
    // A Connect-billed child has its own subscription on the parent's Stripe
    // account — it isn't covered, it's rebilled.
    let coveredBy: { name?: string; contact?: string } | null = null;
    let planKey = ws?.plan;
    if (ws?.parentWorkspaceId && !ws.stripeSubscriptionId && !ws.connectSubscriptionId) {
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
    planChanged(c.get('workspaceId'));
    return c.json({ plan });
  });

  // POST /api/billing/checkout {plan} → Stripe Checkout Session URL
  app.post('/checkout', adminOnly, async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const { plan, interval } = (await c.req.json()) as {
      plan?: string;
      interval?: 'month' | 'year';
    };
    if (!plan || !PLANS[plan]) {
      return c.json({ error: 'unknown or unavailable plan' }, 400);
    }
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);

    // Agency rebilling: a client workspace whose parent has a live Connect
    // account and a retail price for this tier checks out ON THE AGENCY'S
    // Stripe account (direct charge). application_fee_percent skims our
    // wholesale cost out of the agency's retail price — the agency keeps
    // the margin, their brand is on the invoice.
    if (ws?.parentWorkspaceId) {
      const [parent] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, ws.parentWorkspaceId))
        .limit(1);
      const pricing = (parent?.agencyPricing ?? {}) as Record<
        string,
        { price_id: string; retail_cents: number }
      >;
      const entry = plan ? pricing[plan] : undefined;
      if (parent?.stripeConnectId && parent.connectChargesEnabled && entry) {
        const wholesale = PLANS[plan].baseCents;
        const feePct = Math.min(100, Math.round((wholesale / entry.retail_cents) * 10000) / 100);
        // Existing client subscription → swap the price in place rather than
        // stacking a second subscription on the client's card.
        if (ws.connectSubscriptionId) {
          const sub = await s.subscriptions.retrieve(ws.connectSubscriptionId, undefined, {
            stripeAccount: parent.stripeConnectId,
          });
          const item = sub.items.data[0];
          await s.subscriptions.update(
            ws.connectSubscriptionId,
            {
              ...(item ? { items: [{ id: item.id, price: entry.price_id }] } : {}),
              application_fee_percent: feePct,
              metadata: { workspace_id: workspaceId, plan },
            },
            { stripeAccount: parent.stripeConnectId },
          );
          await db.update(workspaces).set({ plan }).where(eq(workspaces.id, workspaceId));
          planChanged(workspaceId);
          await audit(db, {
            workspaceId, userId: c.get('user').id, userName: c.get('user').name,
            action: 'billing.checkout', targetType: 'workspace', targetId: workspaceId,
            meta: { plan, via: 'connect', swapped: true },
          });
          return c.json({ plan, upgraded: true });
        }
        const session = await s.checkout.sessions.create(
          {
            mode: 'subscription',
            line_items: [{ price: entry.price_id, quantity: 1 }],
            subscription_data: {
              application_fee_percent: feePct,
              metadata: { workspace_id: workspaceId, plan },
            },
            metadata: { workspace_id: workspaceId, plan, via: 'connect' },
            success_url: `${env.webOrigin}/billing?upgraded=1`,
            cancel_url: `${env.webOrigin}/billing`,
          },
          { stripeAccount: parent.stripeConnectId },
        );
        await audit(db, {
          workspaceId, userId: c.get('user').id, userName: c.get('user').name,
          action: 'billing.checkout', targetType: 'workspace', targetId: workspaceId,
          meta: { plan, via: 'connect' },
        });
        return c.json({ url: session.url });
      }
    }

    const yearly = interval === 'year';
    const priceId = yearly ? env.stripeYearlyPrices[plan] : env.stripePrices[plan];
    if (!priceId) {
      return c.json(
        { error: yearly ? 'annual billing is not available for this plan' : 'unknown or unavailable plan' },
        400,
      );
    }
    const customerId = await ensureStripeCustomer(s, db, workspaceId, ws, c.get('user').email);

    // Free trial on the first paid checkout — one per workspace, ever.
    const trialDays =
      env.trialDays > 0 &&
      !ws?.trialedAt &&
      !ws?.stripeSubscriptionId &&
      !ws?.connectSubscriptionId
        ? env.trialDays
        : 0;
    if (trialDays) {
      await db
        .update(workspaces)
        .set({ trialedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    }

    // metered items ride on the same subscription: graduated message overage
    // + LLM pass-through; Stripe computes the bill from reported usage
    const line_items: { price: string; quantity?: number }[] = [{ price: priceId, quantity: 1 }];
    const meterPrice = env.stripeMeterPrices[plan];
    if (meterPrice) line_items.push({ price: meterPrice });
    if (env.stripeMeterPrices.llm) line_items.push({ price: env.stripeMeterPrices.llm });
    if (env.stripeMeterPrices.voice) line_items.push({ price: env.stripeMeterPrices.voice });
    if (env.stripeMeterPrices.stt) line_items.push({ price: env.stripeMeterPrices.stt });

    const session = await s.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items,
      metadata: { workspace_id: workspaceId, plan, ...(yearly ? { interval: 'year' } : {}) },
      subscription_data: {
        metadata: { workspace_id: workspaceId, plan },
        ...(trialDays ? { trial_period_days: trialDays } : {}),
      },
      success_url: `${env.webOrigin}/billing?upgraded=1`,
      cancel_url: `${env.webOrigin}/billing`,
    });
    await audit(db, {
      workspaceId, userId: c.get('user').id, userName: c.get('user').name,
      action: 'billing.checkout', targetType: 'workspace', targetId: workspaceId,
      meta: { plan },
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
    if (ws.connectSubscriptionId && ws.parentWorkspaceId) {
      // Agency-billed: cancel on the parent's connected account; the
      // subscription.deleted webhook flips the plan when it lapses.
      const s = stripe();
      const [parent] = await db
        .select({ stripeConnectId: workspaces.stripeConnectId })
        .from(workspaces)
        .where(eq(workspaces.id, ws.parentWorkspaceId))
        .limit(1);
      if (s && parent?.stripeConnectId) {
        try {
          await s.subscriptions.update(
            ws.connectSubscriptionId,
            { cancel_at_period_end: true },
            { stripeAccount: parent.stripeConnectId },
          );
          return c.json({ plan: ws.plan, at_period_end: true });
        } catch {
          // already gone on Stripe's side — flip locally
        }
      }
    }
    await db
      .update(workspaces)
      .set({ plan: 'free', stripeSubscriptionId: null, connectSubscriptionId: null })
      .where(eq(workspaces.id, workspaceId));
    planChanged(workspaceId);
    await audit(db, {
      workspaceId, userId: c.get('user').id, userName: c.get('user').name,
      action: 'billing.downgrade', targetType: 'workspace', targetId: workspaceId,
      meta: { from_plan: ws.plan },
    });
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

  // ---- Agency rebilling (Stripe Connect, GHL-style direct charges) ----
  // Client workspaces subscribe on the AGENCY's connected account at
  // agency-set retail prices; application_fee_percent keeps our wholesale
  // cut. Usage meters stay on the agency's Janis subscription (wholesale
  // cost+margin) — the agency rebills the client however they like.

  interface AgencyPricing {
    [planKey: string]: { price_id: string; retail_cents: number };
  }

  // GET /api/billing/connect — agency-side status: account, charges flag,
  // configured retail prices, and the client workspaces it parents.
  app.get('/connect', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);
    const children = await db
      .select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.parentWorkspaceId, workspaceId));
    const pricing = (ws.agencyPricing ?? {}) as AgencyPricing;
    return c.json({
      connected: Boolean(ws.stripeConnectId),
      charges_enabled: ws.connectChargesEnabled,
      pricing: Object.fromEntries(
        Object.entries(pricing).map(([k, v]) => [k, { retail_cents: v.retail_cents }]),
      ),
      wholesale_cents: Object.fromEntries(
        Object.entries(PLANS)
          .filter(([, p]) => !p.hidden)
          .map(([k, p]) => [k, p.baseCents]),
      ),
      clients: children,
    });
  });

  // POST /api/billing/connect → Stripe Express onboarding link. Idempotent:
  // an existing account re-links into onboarding to finish/repair it.
  app.post('/connect', adminOnly, async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const workspaceId = c.get('workspaceId');
    let [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);

    let acctId = ws.stripeConnectId;
    if (!acctId) {
      const acct = await s.accounts.create({
        type: 'express',
        email: c.get('user').email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_type: 'company',
        metadata: { workspace_id: workspaceId },
      });
      acctId = acct.id;
      await db
        .update(workspaces)
        .set({ stripeConnectId: acctId, connectChargesEnabled: acct.charges_enabled ?? false })
        .where(eq(workspaces.id, workspaceId));
    } else {
      // Re-sync the flag — webhook may not have arrived yet
      const acct = await s.accounts.retrieve(acctId).catch(() => null);
      if (acct) {
        await db
          .update(workspaces)
          .set({ connectChargesEnabled: acct.charges_enabled ?? false })
          .where(eq(workspaces.id, workspaceId));
      }
    }
    const link = await s.accountLinks.create({
      account: acctId,
      refresh_url: `${env.webOrigin}/billing?connect=refresh`,
      return_url: `${env.webOrigin}/billing?connect=done`,
      type: 'account_onboarding',
    });
    await audit(db, {
      workspaceId, userId: c.get('user').id, userName: c.get('user').name,
      action: 'billing.connect', targetType: 'workspace', targetId: workspaceId,
      meta: { connect_account: acctId },
    });
    return c.json({ url: link.url });
  });

  // PUT /api/billing/agency-pricing {retail: {planKey: cents}} — the agency's
  // sell price per tier. Floored at our wholesale (plan baseCents); each tier
  // creates a Price on the CONNECTED account so checkouts are direct charges.
  app.put('/agency-pricing', adminOnly, async (c) => {
    const s = stripe();
    if (!s) return c.json({ error: 'billing not configured' }, 400);
    const workspaceId = c.get('workspaceId');
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);
    if (!ws.stripeConnectId) {
      return c.json({ error: 'connect a Stripe account first' }, 400);
    }
    const { retail } = (await c.req.json()) as { retail?: Record<string, number> };
    if (!retail || typeof retail !== 'object') {
      return c.json({ error: 'retail: {planKey: cents} required' }, 400);
    }
    const pricing = { ...((ws.agencyPricing ?? {}) as AgencyPricing) };
    const out: AgencyPricing = {};
    for (const [key, cents] of Object.entries(retail)) {
      const plan = PLANS[key];
      if (!plan || plan.hidden) continue;
      const retailCents = Math.round(Number(cents));
      if (!Number.isFinite(retailCents) || retailCents < plan.baseCents) {
        return c.json(
          { error: `${key}: retail must be at least $${(plan.baseCents / 100).toFixed(0)}/mo (your wholesale cost)` },
          400,
        );
      }
      const product = await s.products.create(
        { name: `${plan.name} plan`, metadata: { janis_plan: key, workspace_id: workspaceId } },
        { stripeAccount: ws.stripeConnectId },
      );
      const price = await s.prices.create(
        { product: product.id, currency: 'usd', unit_amount: retailCents, recurring: { interval: 'month' } },
        { stripeAccount: ws.stripeConnectId },
      );
      pricing[key] = { price_id: price.id, retail_cents: retailCents };
      out[key] = { price_id: price.id, retail_cents: retailCents };
    }
    if (!Object.keys(out).length) {
      return c.json({ error: 'no valid plans in retail map' }, 400);
    }
    await db
      .update(workspaces)
      .set({ agencyPricing: pricing })
      .where(eq(workspaces.id, workspaceId));
    await audit(db, {
      workspaceId, userId: c.get('user').id, userName: c.get('user').name,
      action: 'billing.agency_pricing', targetType: 'workspace', targetId: workspaceId,
      meta: { retail: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.retail_cents])) },
    });
    return c.json({ pricing: Object.fromEntries(
      Object.entries(pricing).map(([k, v]) => [k, { retail_cents: v.retail_cents }]),
    ) });
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

    // Connected-account events arrive on the same endpoint with `account`
    // set (the platform webhook endpoint needs Connect events enabled —
    // a second endpoint with connect:true pointing at this URL).
    const connectAccount = (event as { account?: string }).account;

    if (event.type === 'account.updated') {
      const acct = event.data.object as { id: string; charges_enabled?: boolean };
      await db
        .update(workspaces)
        .set({ connectChargesEnabled: acct.charges_enabled ?? false })
        .where(eq(workspaces.stripeConnectId, acct.id));
      return c.json({ received: true });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const wsId = session.metadata?.workspace_id;
      const plan = session.metadata?.plan;
      if (wsId && plan && PLANS[plan]) {
        if (connectAccount) {
          // Agency direct charge — the customer/subscription live on the
          // connected account, so they go in the connect_* columns.
          await db
            .update(workspaces)
            .set({
              plan,
              connectCustomerId:
                typeof session.customer === 'string' ? session.customer : session.customer?.id,
              connectSubscriptionId:
                typeof session.subscription === 'string'
                  ? session.subscription
                  : session.subscription?.id,
            })
            .where(eq(workspaces.id, wsId));
        } else {
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
        planChanged(wsId);
      }
    } else if (
      connectAccount &&
      (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted')
    ) {
      // Agency-billed subs: the price is agency-created so plan comes from
      // metadata, and the lookup keys are the connect_* columns.
      const sub = event.data.object;
      const plan = (sub.metadata?.plan as string | undefined) ?? '';
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      const cond = or(
        eq(workspaces.connectSubscriptionId, sub.id),
        customerId ? eq(workspaces.connectCustomerId, customerId) : undefined,
      );
      const updated =
        event.type === 'customer.subscription.deleted'
          ? await db
              .update(workspaces)
              .set({ plan: 'free', connectSubscriptionId: null })
              .where(cond)
              .returning({ id: workspaces.id })
          : plan && PLANS[plan]
            ? await db
                .update(workspaces)
                .set({ plan, connectSubscriptionId: sub.id })
                .where(cond)
                .returning({ id: workspaces.id })
            : [];
      for (const ws of updated) planChanged(ws.id);
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
        for (const ws of updated) planChanged(ws.id);
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
      for (const ws of updated) planChanged(ws.id);
    }

    return c.json({ received: true });
  });

  return app;
}
