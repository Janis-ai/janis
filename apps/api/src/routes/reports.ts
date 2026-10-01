import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  campaignSends,
  campaigns,
  channelBindings,
  channels,
  contacts,
  conversations,
  messages,
  pendingActions,
  usageEvents,
  users as usersTable,
} from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentVis } from '../lib/access.js';
import { currentPeriod } from '../lib/billing.js';
import { effectivePlanKey, messagesInPeriod, planFor } from '../lib/plans.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drill-down filters shared by the report endpoints: a single agent, and a
 * single channel (conversations bind one channel each). */
function drillFilters(c: { req: { query: (k: string) => string | undefined } }): SQL[] {
  const q = (k: string) => {
    const v = c.req.query(k);
    return v && UUID.test(v) ? v : undefined;
  };
  const agentId = q('agent_id');
  const channelId = q('channel_id');
  const conds: SQL[] = [];
  if (agentId) conds.push(eq(conversations.agentId, agentId));
  if (channelId)
    conds.push(
      sql`exists (
        select 1 from ${channelBindings}
        where ${channelBindings.conversationId} = ${conversations.id}
          and ${channelBindings.channelId} = ${channelId}
      )`,
    );
  return conds;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Shared report window: `?days=N` presets, or `?from=`/`?to=` for a custom
 * range. `to` is inclusive when given as a plain date (YYYY-MM-DD) — the
 * returned `end` is already exclusive. Invalid/missing params fall back to
 * the days preset so old links keep working. */
function reportRange(
  c: { req: { query: (k: string) => string | undefined } },
  cap = 90,
  defDays = 30,
): { days: number; cutoff: Date; end: Date } {
  const fromQ = c.req.query('from');
  const from = fromQ ? new Date(fromQ) : null;
  if (from && !Number.isNaN(from.getTime())) {
    const toQ = c.req.query('to');
    let end = toQ ? new Date(toQ) : new Date();
    if (toQ && DATE_ONLY.test(toQ)) end = new Date(end.getTime() + 86_400_000);
    if (!Number.isNaN(end.getTime()) && end > from)
      return {
        days: Math.max(1, Math.ceil((end.getTime() - from.getTime()) / 86_400_000)),
        cutoff: from,
        end,
      };
  }
  const days = Math.min(Math.max(Number(c.req.query('days')) || defDays, 1), cap);
  const end = new Date();
  return { days, cutoff: new Date(end.getTime() - days * 86_400_000), end };
}
export function reportRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /handoffs?days=30&agent_id=&channel_id= — volume, response times,
  // unresolved/overdue counts. Drill down per agent, then per channel.
  app.get('/handoffs', async (c) => {
    const { days, cutoff, end } = reportRange(c);

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
          gte(alerts.createdAt, cutoff),
          lt(alerts.createdAt, end),
          ne(alerts.type, 'sla'), // sla alerts are re-alerts, not new handoffs
          ne(alerts.type, 'keyword'),
          ...drillFilters(c),
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
    const { days, cutoff, end } = reportRange(c);

    const convs = await db
      .select({
        id: conversations.id,
        state: conversations.state,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...agentVis(c.get('workspaceId'), c.get('agentScope')),
          gte(conversations.createdAt, cutoff),
          lt(conversations.createdAt, end),
          ...drillFilters(c),
        ),
      );

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

  // GET /csat?days=30 — post-resolution ratings: average score, distribution,
  // and what share of prompted customers answered.
  app.get('/csat', async (c) => {
    const { days, cutoff, end } = reportRange(c);

    const rows = await db
      .select({
        id: conversations.id,
        score: conversations.csatScore,
        askedAt: conversations.csatAskedAt,
        pending: conversations.csatPending,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...agentVis(c.get('workspaceId'), c.get('agentScope')),
          gte(conversations.csatAskedAt, cutoff),
          lt(conversations.csatAskedAt, end),
          ...drillFilters(c),
        ),
      );

    const dist = [0, 0, 0, 0, 0];
    let sum = 0;
    let answered = 0;
    for (const r of rows) {
      if (r.score === null) continue;
      answered++;
      sum += r.score;
      dist[Math.min(Math.max(r.score, 1), 5) - 1]++;
    }
    return c.json({
      days,
      prompted: rows.length,
      answered,
      response_rate: rows.length ? Math.round((answered / rows.length) * 100) : null,
      avg_score: answered ? Math.round((sum / answered) * 100) / 100 : null,
      // share of 4–5 ratings — the industry CSAT headline
      satisfied_pct: answered ? Math.round(((dist[3] + dist[4]) / answered) * 100) : null,
      distribution: dist.map((n, i) => ({ score: i + 1, count: n })),
    });
  });

  // GET /intents?days=30 — conversation volume grouped by classified topic,
  // with per-topic CSAT so "billing makes people angrier than shipping" is
  // visible, not just counted.
  app.get('/intents', async (c) => {
    const { days, cutoff, end } = reportRange(c);

    const rows = await db
      .select({
        intent: conversations.intent,
        csat: conversations.csatScore,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...agentVis(c.get('workspaceId'), c.get('agentScope')),
          gte(conversations.createdAt, cutoff),
          lt(conversations.createdAt, end),
          ...drillFilters(c),
        ),
      );

    const byIntent = new Map<string, { count: number; scores: number[] }>();
    for (const r of rows) {
      const key = r.intent ?? 'unclassified';
      const slot = byIntent.get(key) ?? { count: 0, scores: [] };
      slot.count++;
      if (r.csat !== null) slot.scores.push(r.csat);
      byIntent.set(key, slot);
    }
    return c.json({
      days,
      total: rows.length,
      classified: rows.length - (byIntent.get('unclassified')?.count ?? 0),
      intents: [...byIntent.entries()]
        .map(([intent, s]) => ({
          intent,
          count: s.count,
          avg_csat: s.scores.length
            ? Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100) / 100
            : null,
        }))
        .sort((a, b) => b.count - a.count),
    });
  });

  // GET /operators?days=30 — per-teammate workload + responsiveness: how many
  // conversations each operator touched, replies sent, median first-response
  // and resolution times, and what's currently sitting in their name.
  app.get('/operators', async (c) => {
    const { days, cutoff, end } = reportRange(c);
    const scope = agentVis(c.get('workspaceId'), c.get('agentScope'));

    const convs = await db
      .select({
        id: conversations.id,
        assigneeId: conversations.assigneeId,
        createdAt: conversations.createdAt,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(...scope, gte(conversations.createdAt, cutoff), lt(conversations.createdAt, end), ...drillFilters(c)));
    if (!convs.length) return c.json({ days, operators: [] });
    const convIds = convs.map((v) => v.id);
    const convById = new Map(convs.map((v) => [v.id, v]));

    // Human-authored transcript lines — 'human' rows and operator sends
    // (via:'operator' on out messages) both carry authorId = the user.
    const rows = await db
      .select({
        convId: messages.conversationId,
        authorId: messages.authorId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, convIds),
          sql`${messages.authorId} is not null`,
        ),
      )
      .orderBy(asc(messages.createdAt));

    // Currently assigned (open workload) — not window-limited.
    const assigned = await db
      .select({ assigneeId: conversations.assigneeId })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...scope,
          sql`${conversations.assigneeId} is not null`,
          ne(conversations.state, 'archived'),
          ...drillFilters(c),
        ),
      );
    const assignedNow = new Map<string, number>();
    for (const a of assigned) {
      assignedNow.set(a.assigneeId!, (assignedNow.get(a.assigneeId!) ?? 0) + 1);
    }

    interface Stat {
      convs: Set<string>;
      replies: number;
      firstResp: number[]; // ms, conv created → their first message
      resolution: number[]; // ms, conv created → archived (convs they touched)
      assigned: number;
    }
    const stats = new Map<string, Stat>();
    const stat = (uid: string) => {
      let s = stats.get(uid);
      if (!s) {
        s = { convs: new Set(), replies: 0, firstResp: [], resolution: [], assigned: 0 };
        stats.set(uid, s);
      }
      return s;
    };
    // First message per operator per conversation, in time order
    const seen = new Set<string>();
    for (const m of rows) {
      const s = stat(m.authorId!);
      s.convs.add(m.convId);
      s.replies++;
      const key = `${m.authorId}:${m.convId}`;
      const conv = convById.get(m.convId);
      if (!seen.has(key) && conv) {
        seen.add(key);
        s.firstResp.push(m.createdAt.getTime() - conv.createdAt.getTime());
      }
    }
    for (const [uid, s] of stats) {
      for (const convId of s.convs) {
        const conv = convById.get(convId);
        if (conv?.archivedAt) s.resolution.push(conv.archivedAt.getTime() - conv.createdAt.getTime());
      }
      s.assigned = assignedNow.get(uid) ?? 0;
    }

    const ids = [...stats.keys(), ...assignedNow.keys()];
    const users = ids.length
      ? await db
          .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
          .from(usersTable)
          .where(inArray(usersTable.id, [...new Set(ids)]))
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name || u.email]));

    const med = (ms: number[]) =>
      ms.length
        ? Math.round((ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] / 60_000) * 10) / 10
        : null;

    return c.json({
      days,
      operators: [...stats.entries()]
        .map(([uid, s]) => ({
          user_id: uid,
          name: nameOf.get(uid) ?? 'unknown',
          conversations: s.convs.size,
          replies: s.replies,
          median_first_response_min: med(s.firstResp),
          median_resolution_min: med(s.resolution),
          assigned_now: s.assigned,
        }))
        .sort((a, b) => b.conversations - a.conversations),
    });
  });

  // GET /volume?days=30 — daily time-series for the volume chart: new
  // conversations + messages by direction (in / out / human). Uses the same
  // workspace scope + drill filters as the metric cards.
  app.get('/volume', async (c) => {
    const { days, cutoff, end } = reportRange(c);
    const scope = and(
      ...agentVis(c.get('workspaceId'), c.get('agentScope')),
      gte(conversations.createdAt, cutoff),
      lt(conversations.createdAt, end),
      ...drillFilters(c),
    );
    const day = (col: SQL | typeof conversations.createdAt | typeof messages.createdAt) =>
      sql<string>`to_char(date_trunc('day', ${col} at time zone 'UTC'), 'YYYY-MM-DD')`;

    const convRows = await db
      .select({ d: day(conversations.createdAt), n: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(scope)
      .groupBy(sql`1`);
    const msgRows = await db
      .select({
        d: day(messages.createdAt),
        dir: messages.direction,
        n: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(gte(messages.createdAt, cutoff), lt(messages.createdAt, end), ...agentVis(c.get('workspaceId'), c.get('agentScope')), ...drillFilters(c)))
      .groupBy(sql`1`, messages.direction);

    const series = new Map<string, { date: string; conversations: number; in: number; out: number; human: number }>();
    const slot = (d: string) => {
      let s = series.get(d);
      if (!s) {
        s = { date: d, conversations: 0, in: 0, out: 0, human: 0 };
        series.set(d, s);
      }
      return s;
    };
    for (const r of convRows) slot(r.d).conversations = r.n;
    for (const r of msgRows) {
      if (r.dir === 'in') slot(r.d).in += r.n;
      else if (r.dir === 'out') slot(r.d).out += r.n;
      else if (r.dir === 'human') slot(r.d).human += r.n;
    }
    return c.json({
      days,
      series: [...series.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    });
  });

  // GET /campaigns?days=30 — outbound performance over the window: sends by
  // outcome plus reply/conversion attribution, per campaign. Sends count the
  // day they were recorded (queued or delivered).
  app.get('/campaigns', async (c) => {
    const { days, cutoff, end } = reportRange(c);
    const rows = await db
      .select({
        campaignId: campaigns.id,
        name: campaigns.name,
        status: campaignSends.status,
        repliedAt: campaignSends.repliedAt,
        convertedAt: campaignSends.convertedAt,
      })
      .from(campaignSends)
      .innerJoin(campaigns, eq(campaignSends.campaignId, campaigns.id))
      .where(
        and(
          eq(campaignSends.workspaceId, c.get('workspaceId')),
          gte(campaignSends.createdAt, cutoff),
          lt(campaignSends.createdAt, end),
        ),
      );

    interface Agg {
      sends: number; sent: number; pending: number; failed: number;
      skipped: number; replied: number; converted: number;
    }
    const byCampaign = new Map<string, { name: string } & Agg>();
    const totals: Agg = { sends: 0, sent: 0, pending: 0, failed: 0, skipped: 0, replied: 0, converted: 0 };
    const bump = (a: Agg, r: { status: string; repliedAt: Date | null; convertedAt: Date | null }) => {
      a.sends++;
      if (r.status === 'sent') a.sent++;
      else if (r.status === 'pending') a.pending++;
      else if (r.status === 'failed') a.failed++;
      else a.skipped++; // skipped_opted_out / suppressed / frequency_cap / cancelled
      if (r.repliedAt) a.replied++;
      if (r.convertedAt) a.converted++;
    };
    for (const r of rows) {
      bump(totals, r);
      const slot = byCampaign.get(r.campaignId) ?? { name: r.name, sends: 0, sent: 0, pending: 0, failed: 0, skipped: 0, replied: 0, converted: 0 };
      bump(slot, r);
      byCampaign.set(r.campaignId, slot);
    }
    return c.json({
      days,
      totals,
      campaigns: [...byCampaign.entries()]
        .map(([id, a]) => ({ id, ...a, reply_rate: a.sent ? Math.round((a.replied / a.sent) * 100) : null }))
        .sort((a, b) => b.sends - a.sends),
    });
  });

  // GET /timeline?days=30 — response/resolution speed over time + the
  // AI-vs-human split on resolved conversations. "Deflection" = share of
  // resolved convs closed with zero human-authored customer-facing message —
  // the ROI number: how much queue the agent absorbed alone.
  app.get('/timeline', async (c) => {
    const { days, cutoff, end } = reportRange(c);
    const scope = agentVis(c.get('workspaceId'), c.get('agentScope'));

    // Opened-in-window feeds the FRT/opened series; archived-in-window feeds
    // resolution/deflection — a conv created before the window but closed in
    // it still counts toward the day it closed.
    const convs = await db
      .select({
        id: conversations.id,
        createdAt: conversations.createdAt,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          ...scope,
          sql`((${conversations.createdAt} >= ${cutoff} and ${conversations.createdAt} < ${end}) or (${conversations.archivedAt} >= ${cutoff} and ${conversations.archivedAt} < ${end}))`,
          ...drillFilters(c),
        ),
      );
    if (!convs.length) {
      return c.json({
        days,
        opened: 0,
        resolved: 0,
        resolution_rate: null,
        ai_resolved: 0,
        human_resolved: 0,
        deflection_rate: null,
        median_frt_min: null,
        median_resolution_min: null,
        series: [],
      });
    }
    const convById = new Map(convs.map((v) => [v.id, v]));

    const msgs = await db
      .select({
        convId: messages.conversationId,
        direction: messages.direction,
        createdAt: messages.createdAt,
        payload: messages.payload,
      })
      .from(messages)
      .where(inArray(messages.conversationId, [...convById.keys()]))
      .orderBy(asc(messages.createdAt));

    const firstIn = new Map<string, Date>();
    const firstReply = new Map<string, Date>();
    const humanTouched = new Set<string>();
    for (const m of msgs) {
      const p = m.payload as { internal?: boolean; via?: string } | undefined;
      if (m.direction === 'in' && !firstIn.has(m.convId)) firstIn.set(m.convId, m.createdAt);
      if (p?.internal) continue;
      if (m.direction === 'human' || p?.via === 'operator') {
        humanTouched.add(m.convId);
        if (!firstReply.has(m.convId)) firstReply.set(m.convId, m.createdAt);
      } else if (m.direction === 'out' && !firstReply.has(m.convId)) {
        firstReply.set(m.convId, m.createdAt);
      }
    }

    interface Slot {
      date: string;
      opened: number;
      frt: number[]; // minutes, first inbound → first reply
      resolutions: number;
      resolutionMin: number[]; // minutes, opened → archived
      ai: number;
      human: number;
    }
    const byDay = new Map<string, Slot>();
    const slot = (d: string) => {
      let s = byDay.get(d);
      if (!s) {
        s = { date: d, opened: 0, frt: [], resolutions: 0, resolutionMin: [], ai: 0, human: 0 };
        byDay.set(d, s);
      }
      return s;
    };
    const day = (d: Date) => d.toISOString().slice(0, 10);

    let opened = 0;
    const frtAll: number[] = [];
    const resAll: number[] = [];
    let aiResolved = 0;
    let humanResolved = 0;
    for (const conv of convs) {
      if (conv.createdAt >= cutoff && conv.createdAt < end) {
        opened++;
        const s = slot(day(conv.createdAt));
        s.opened++;
        const inbound = firstIn.get(conv.id) ?? conv.createdAt;
        const reply = firstReply.get(conv.id);
        if (reply && reply >= inbound) {
          const m = (reply.getTime() - inbound.getTime()) / 60_000;
          s.frt.push(m);
          frtAll.push(m);
        }
      }
      if (conv.archivedAt && conv.archivedAt >= cutoff && conv.archivedAt < end) {
        const s = slot(day(conv.archivedAt));
        s.resolutions++;
        const m = (conv.archivedAt.getTime() - conv.createdAt.getTime()) / 60_000;
        s.resolutionMin.push(m);
        resAll.push(m);
        if (humanTouched.has(conv.id)) {
          s.human++;
          humanResolved++;
        } else {
          s.ai++;
          aiResolved++;
        }
      }
    }

    const med = (ms: number[]) =>
      ms.length
        ? Math.round(ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] * 10) / 10
        : null;
    const resolved = aiResolved + humanResolved;
    return c.json({
      days,
      opened,
      resolved,
      resolution_rate: opened ? Math.round((resolved / opened) * 100) : null,
      ai_resolved: aiResolved,
      human_resolved: humanResolved,
      deflection_rate: resolved ? Math.round((aiResolved / resolved) * 100) : null,
      median_frt_min: med(frtAll),
      median_resolution_min: med(resAll),
      series: [...byDay.values()]
        .map((s) => ({
          date: s.date,
          opened: s.opened,
          frt_min: med(s.frt),
          resolutions: s.resolutions,
          resolution_min: med(s.resolutionMin),
          ai_resolved: s.ai,
          human_resolved: s.human,
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    });
  });

  // GET /usage — current + previous billing period against the plan:
  // stored messages vs includedMessages, LLM token/cost burn, voice seconds.
  app.get('/usage', async (c) => {
    const ws = c.get('workspaceId');
    const [planKey, used] = await Promise.all([
      effectivePlanKey(db, ws),
      messagesInPeriod(db, ws),
    ]);
    const plan = planFor(planKey);
    const period = currentPeriod();
    const prevPeriod = (() => {
      const [y, m] = period.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 2, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();

    const rollups = await db
      .select({
        period: usageEvents.period,
        kind: usageEvents.kind,
        qty: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
        prompt: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)::int`,
        completion: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)::int`,
        micros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)::int`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.workspaceId, ws), inArray(usageEvents.period, [period, prevPeriod])))
      .groupBy(usageEvents.period, usageEvents.kind);

    const shape = (p: string) => {
      const rows = rollups.filter((r) => r.period === p);
      const llm = rows.find((r) => r.kind === 'llm_tokens');
      const voice = rows.find((r) => r.kind === 'voice_seconds');
      return {
        period: p,
        llm_prompt_tokens: llm?.prompt ?? 0,
        llm_completion_tokens: llm?.completion ?? 0,
        llm_cost_usd: Math.round(((llm?.micros ?? 0) / 1e6) * 100) / 100,
        voice_seconds: voice?.qty ?? 0,
      };
    };
    return c.json({
      plan: { key: planKey, name: plan.name, included_messages: plan.includedMessages, base_cents: plan.baseCents, overage_per_1k_cents: plan.overagePer1kCents },
      messages_used: used,
      messages_remaining: Math.max(0, plan.includedMessages - used),
      current: shape(period),
      previous: shape(prevPeriod),
    });
  });

  // GET /export?kind=conversations|campaign_sends&days=90 — CSV download.
  // Same visibility scope as the metrics; capped at 5000 rows.
  app.get('/export', async (c) => {
    const kind = c.req.query('kind') ?? 'conversations';
    const { days, cutoff, end } = reportRange(c, 365, 90);
    const scope = and(
      ...agentVis(c.get('workspaceId'), c.get('agentScope')),
      gte(conversations.createdAt, cutoff),
      lt(conversations.createdAt, end),
      ...drillFilters(c),
    );
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const iso = (d: Date | null) => (d ? d.toISOString() : '');

    let head: string[];
    let lines: string[];
    if (kind === 'campaign_sends') {
      const rows = await db
        .select({
          campaign: campaigns.name,
          step: campaignSends.stepIndex,
          recipient: campaignSends.recipient,
          status: campaignSends.status,
          sent: campaignSends.sentAt,
          replied: campaignSends.repliedAt,
          converted: campaignSends.convertedAt,
          error: campaignSends.error,
        })
        .from(campaignSends)
        .innerJoin(campaigns, eq(campaignSends.campaignId, campaigns.id))
        .where(and(eq(campaignSends.workspaceId, c.get('workspaceId')), gte(campaignSends.createdAt, cutoff), lt(campaignSends.createdAt, end)))
        .orderBy(desc(campaignSends.createdAt))
        .limit(5000);
      head = ['campaign', 'step', 'recipient', 'status', 'sent_at', 'replied_at', 'converted_at', 'error'];
      lines = rows.map((r) =>
        [r.campaign, r.step, r.recipient, r.status, iso(r.sent), iso(r.replied), iso(r.converted), r.error]
          .map(esc).join(','));
    } else {
      const rows = await db
        .select({
          id: conversations.id,
          state: conversations.state,
          intent: conversations.intent,
          csat: conversations.csatScore,
          agent: agents.name,
          channel: sql<string>`(select ch.kind from ${channelBindings} cb join ${channels} ch on ch.id = cb.channel_id where cb.conversation_id = ${conversations.id} order by cb.created_at limit 1)`,
          contact: contacts.name,
          email: contacts.email,
          phone: contacts.phone,
          created: conversations.createdAt,
          archived: conversations.archivedAt,
        })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .leftJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(scope)
        .orderBy(desc(conversations.createdAt))
        .limit(5000);
      head = ['id', 'created_at', 'state', 'agent', 'channel', 'contact', 'email', 'phone', 'intent', 'csat', 'archived_at'];
      lines = rows.map((r) =>
        [r.id, iso(r.created), r.state, r.agent, r.channel, r.contact, r.email, r.phone, r.intent, r.csat, iso(r.archived)]
          .map(esc).join(','));
    }
    return new Response([head.join(','), ...lines].join('\n') + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="janis-${kind}-${days}d.csv"`,
      },
    });
  });

  return app;
}
