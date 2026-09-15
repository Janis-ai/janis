import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, usageEvents } from '../db/schema.js';
import { billingConfig, currentPeriod } from '../lib/billing.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

export function billingRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/billing/summary?period=YYYY-MM — usage + estimated invoice
  app.get('/summary', async (c) => {
    const workspaceId = c.get('workspaceId');
    const period = c.req.query('period') ?? currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: 'period must be YYYY-MM' }, 400);

    const [totals] = await db
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

    // estimated invoice: (metered LLM cost + infra share + channels) * (1 + margin)
    const usageCents = Number(totals.costMicros) / 10_000; // micros -> cents
    const infraCents = billingConfig.baseCents + channelCount * billingConfig.channelCents;
    const subtotalCents = usageCents + infraCents;
    const marginCents = Math.round(subtotalCents * billingConfig.margin);

    return c.json({
      period,
      tokens: {
        prompt: totals.promptTokens,
        completion: totals.completionTokens,
        total: totals.promptTokens + totals.completionTokens,
      },
      llm_calls: totals.events,
      costs: {
        usage_cents: Math.round(usageCents * 100) / 100,
        infra_cents: infraCents,
        subtotal_cents: Math.round(subtotalCents * 100) / 100,
        margin_cents: marginCents,
        margin_pct: billingConfig.margin * 100,
        total_cents: Math.round(subtotalCents * 100) / 100 + marginCents,
      },
      channels_connected: channelCount,
      by_agent: byAgent.map((r) => ({
        agent_id: r.agentId,
        agent_name: r.agentName ?? '(deleted)',
        tokens: r.promptTokens + r.completionTokens,
        llm_calls: r.events,
        cost_cents: Math.round((Number(r.costMicros) / 10_000) * 100) / 100,
      })),
    });
  });

  return app;
}
