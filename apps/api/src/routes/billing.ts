import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, usageEvents, workspaces } from '../db/schema.js';
import { billingConfig, currentPeriod } from '../lib/billing.js';
import { messagesInPeriod, planFor, PLANS } from '../lib/plans.js';
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

  // PATCH /api/billing/plan {plan} — admin-only; Stripe checkout takes over later
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

  return app;
}
