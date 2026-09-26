import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentVis } from '../lib/access.js';

/** Handoff metrics for the Reports page — mounted at /api/reports. */
export function reportRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /handoffs?days=30 — volume, response times, unresolved/overdue counts.
  app.get('/handoffs', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const handoffs = await db
      .select({
        alert: alerts,
        conv: conversations,
        sla: agents.config,
      })
      .from(alerts)
      .innerJoin(conversations, eq(alerts.conversationId, conversations.id))
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...agentVis(c.get('workspaceId'), c.get('agentScope')),
          gt(alerts.createdAt, cutoff),
          ne(alerts.type, 'sla'), // sla alerts are re-alerts, not new handoffs
          ne(alerts.type, 'keyword'),
        ),
      )
      .orderBy(asc(alerts.createdAt));

    // First human reply per conversation, batched
    const convIds = [...new Set(handoffs.map((h) => h.conv.id))];
    const humanMsgs = convIds.length
      ? await db
          .select({
            convId: messages.conversationId,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              inArray(messages.conversationId, convIds),
              eq(messages.direction, 'human'),
            ),
          )
          .orderBy(asc(messages.createdAt))
      : [];
    const humansByConv = new Map<string, Date[]>();
    for (const m of humanMsgs) {
      const list = humansByConv.get(m.convId) ?? [];
      list.push(m.createdAt);
      humansByConv.set(m.convId, list);
    }

    const responseMins: number[] = [];
    let responded = 0;
    let unresolved = 0;
    let overdue = 0;
    const staleList: { id: string; name: string; waiting_min: number }[] = [];

    for (const h of handoffs) {
      const firstHuman = (humansByConv.get(h.conv.id) ?? []).find(
        (t) => t > h.alert.createdAt,
      );
      if (firstHuman) {
        responded++;
        responseMins.push((firstHuman.getTime() - h.alert.createdAt.getTime()) / 60_000);
      }
      const stillOpen = h.alert.status === 'open' && h.conv.state === 'needs_human';
      if (stillOpen) {
        unresolved++;
        const sla = (h.sla as { sla_minutes?: number } | null)?.sla_minutes ?? 15;
        const waitingMin = (Date.now() - h.alert.createdAt.getTime()) / 60_000;
        if (waitingMin > sla) {
          overdue++;
          const p = (h.conv.userProfile ?? {}) as { name?: string; username?: string; email?: string };
          staleList.push({
            id: h.conv.id,
            name:
              p.name ??
              (p.username ? `@${p.username}` : undefined) ??
              p.email ??
              friendlyName(h.conv.externalId),
            waiting_min: Math.round(waitingMin),
          });
        }
      }
    }

    responseMins.sort((a, b) => a - b);
    const median = responseMins.length
      ? responseMins[Math.floor(responseMins.length / 2)]
      : null;

    return c.json({
      days,
      handoffs: handoffs.length,
      responded,
      response_rate: handoffs.length ? Math.round((responded / handoffs.length) * 100) : null,
      avg_first_response_min: responseMins.length
        ? Math.round((responseMins.reduce((s, v) => s + v, 0) / responseMins.length) * 10) / 10
        : null,
      median_first_response_min: median ? Math.round(median * 10) / 10 : null,
      unresolved,
      overdue,
      stale: staleList.sort((a, b) => b.waiting_min - a.waiting_min).slice(0, 5),
    });
  });

  return app;
}
