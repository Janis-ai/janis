import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages, pendingActions } from '../db/schema.js';
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

  // GET /containment?days=30 — what the agent handled alone. The support-AI
  // headline number: share of conversations that never needed a human.
  // "Escalated" = an alert (help request, failure, approval…) fired or a
  // human sent a message or took over; "contained" = the agent replied and
  // none of that happened.
  app.get('/containment', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const convs = await db
      .select({
        id: conversations.id,
        state: conversations.state,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(...agentVis(c.get('workspaceId'), c.get('agentScope')), gt(conversations.createdAt, cutoff)));

    const convIds = convs.map((v) => v.id);
    if (!convIds.length) {
      return c.json({
        days,
        total: 0,
        contained: 0,
        escalated: 0,
        no_reply: 0,
        containment_rate: null,
        approvals_requested: 0,
        approvals_pending: 0,
        avg_handoff_min: null,
        median_handoff_min: null,
        median_decision_min: null,
        series: [],
      });
    }

    const msgs = await db
      .select({
        convId: messages.conversationId,
        direction: messages.direction,
        createdAt: messages.createdAt,
        payload: messages.payload,
      })
      .from(messages)
      .where(inArray(messages.conversationId, convIds))
      .orderBy(asc(messages.createdAt));

    const convAlerts = await db
      .select({ convId: alerts.conversationId, type: alerts.type, createdAt: alerts.createdAt })
      .from(alerts)
      .where(and(inArray(alerts.conversationId, convIds), ne(alerts.type, 'sla')));

    const approvalRows = await db
      .select({
        convId: pendingActions.conversationId,
        status: pendingActions.status,
        createdAt: pendingActions.createdAt,
        decidedAt: pendingActions.decidedAt,
      })
      .from(pendingActions)
      .where(inArray(pendingActions.conversationId, convIds));

    // Escalating alert types — approval_request is gated action, not a
    // failure of containment, so it doesn't count as escalation here.
    const ESCALATING = new Set(['failure', 'help_request', 'handoff_offer', 'custom', 'keyword']);
    const alertsByConv = new Map<string, Date[]>();
    for (const a of convAlerts) {
      if (!ESCALATING.has(a.type)) continue;
      const list = alertsByConv.get(a.convId) ?? [];
      list.push(a.createdAt);
      alertsByConv.set(a.convId, list);
    }
    const firstAgentReply = new Map<string, Date>();
    const firstHumanMsg = new Map<string, Date>();
    for (const m of msgs) {
      const p = m.payload as { internal?: boolean; via?: string } | undefined;
      if (p?.internal) continue; // approval cards/notes — never customer-facing
      if (m.direction === 'out' && p?.via !== 'operator' && !firstAgentReply.has(m.convId))
        firstAgentReply.set(m.convId, m.createdAt);
      // 'human' rows and 'out' messages sent via the operator composer both
      // mean a person touched the conversation.
      if ((m.direction === 'human' || p?.via === 'operator') && !firstHumanMsg.has(m.convId))
        firstHumanMsg.set(m.convId, m.createdAt);
    }

    let contained = 0;
    let escalated = 0;
    let noReply = 0;
    const handoffMins: number[] = [];
    // Daily cohorts for the trend line — a conversation counts toward the
    // day it opened; escalations later in its life still mark it escalated.
    const byDay = new Map<string, { total: number; contained: number }>();
    for (const conv of convs) {
      const replied = firstAgentReply.has(conv.id);
      const humanMsg = firstHumanMsg.get(conv.id);
      const firstAlert = alertsByConv.get(conv.id)?.[0];
      const intervention = [humanMsg, firstAlert]
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const day = conv.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { total: 0, contained: 0 };
      bucket.total++;
      if (!replied) {
        noReply++;
      } else if (intervention) {
        escalated++;
        handoffMins.push((intervention.getTime() - conv.createdAt.getTime()) / 60_000);
      } else {
        contained++;
        bucket.contained++;
      }
      byDay.set(day, bucket);
    }

    // How long gated actions sit with a human — request to approve/deny.
    const decisionMins = approvalRows
      .filter((a) => a.decidedAt)
      .map((a) => (a.decidedAt!.getTime() - a.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);

    handoffMins.sort((a, b) => a - b);
    return c.json({
      days,
      total: convs.length,
      contained,
      escalated,
      no_reply: noReply,
      containment_rate: convs.length ? Math.round((contained / convs.length) * 100) : null,
      approvals_requested: approvalRows.length,
      approvals_pending: approvalRows.filter((a) => a.status === 'pending').length,
      avg_handoff_min: handoffMins.length
        ? Math.round((handoffMins.reduce((s, v) => s + v, 0) / handoffMins.length) * 10) / 10
        : null,
      median_handoff_min: handoffMins.length
        ? Math.round(handoffMins[Math.floor(handoffMins.length / 2)] * 10) / 10
        : null,
      median_decision_min: decisionMins.length
        ? Math.round(decisionMins[Math.floor(decisionMins.length / 2)] * 10) / 10
        : null,
      series: [...byDay.entries()]
        .map(([date, v]) => ({ date, total: v.total, contained: v.contained }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    });
  });

  return app;
}
