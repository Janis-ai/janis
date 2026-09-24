import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, alerts, conversations, messages } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { alertNotification, notifyWorkspace } from '../lib/notify.js';
import { inactivityThresholds } from '../lib/rules.js';
import { toAlert, toMessage } from '../lib/serializers.js';
import { mirrorToSlack, postSlackAlert } from '../lib/slack.js';
import { resume } from './takeover.js';

/**
 * Periodically:
 *  - escalate 'active' conversations where the end user is waiting
 *    (last message inbound) past the agent's inactivity threshold
 *  - auto-release 'human' takeovers past the agent's auto_resume_minutes
 *  - re-alert 'needs_human' conversations unclaimed past the agent's SLA
 */
export function startSweeper(db: Db, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    void sweep(db).catch((err) => console.error('sweep error:', err));
    void sweepAutoResume(db).catch((err) => console.error('sweepAutoResume error:', err));
    void sweepSla(db).catch((err) => console.error('sweepSla error:', err));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweepAutoResume(db: Db): Promise<number> {
  // Per-takeover override wins (legacy /pause N): pause_minutes null → agent
  // default, -1 → never auto-resume.
  const rows = await db
    .select({ conv: conversations, agent: agents })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.state, 'human'));

  let fired = 0;
  const now = Date.now();
  for (const { conv, agent } of rows) {
    const minutes = conv.pauseMinutes ?? agent.autoResumeMinutes;
    if (minutes == null || minutes < 0 || !conv.humanSince) continue;
    const windowMs = minutes * 60_000;
    const cutoff = new Date(now - windowMs);
    // Warn shortly before the takeover expires (legacy warningSent). Lead is
    // 60s or half the window, whichever is shorter.
    const warnCutoff = new Date(cutoff.getTime() + Math.min(60_000, windowMs / 2));

    if (conv.humanSince < cutoff) {
      await resume(db, agent.workspaceId, conv.id, null);
      fired++;
      continue;
    }

    // Inside the warning window, not yet warned for this humanSince → warn.
    // resumeWarnedAt < humanSince re-arms the warning when operator activity
    // pushes the clock out again.
    const staleWarning =
      conv.resumeWarnedAt == null || conv.resumeWarnedAt < conv.humanSince;
    if (conv.humanSince < warnCutoff && staleWarning) {
      await db
        .update(conversations)
        .set({ resumeWarnedAt: new Date() })
        .where(eq(conversations.id, conv.id));
      const remainingMin = Math.max(
        1,
        Math.round((conv.humanSince.getTime() + windowMs - now) / 60_000),
      );
      // Same warning in the Janis transcript — an internal event row like
      // takeover/resume notices, never sent to the customer.
      const [note] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: 'human',
          text: `takeover auto-resumes in ~${remainingMin}m — reply to keep control`,
          payload: { internal: true, event: 'auto-resume warning' },
        })
        .returning();
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
      void mirrorToSlack(
        db,
        conv.id,
        ':hourglass_flowing_sand:',
        `_takeover auto-resumes in ~${remainingMin}m — reply in this thread to keep control_`,
      );
    }
  }
  return fired;
}

export async function sweep(db: Db): Promise<number> {
  const rules = await db.select().from(alertRules).where(eq(alertRules.kind, 'inactivity'));
  if (rules.length === 0) return 0;

  // smallest configured threshold per agent
  const thresholdByAgent = new Map<string, number>();
  for (const rule of rules) {
    for (const minutes of inactivityThresholds([rule])) {
      const current = thresholdByAgent.get(rule.agentId);
      if (current === undefined || minutes < current) thresholdByAgent.set(rule.agentId, minutes);
    }
  }

  let fired = 0;
  for (const [agentId, minutes] of thresholdByAgent) {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    const stale = await db
      .select({ conversation: conversations, agent: agents })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.state, 'active'),
          eq(conversations.lastMessageDirection, 'in'),
          lt(conversations.lastMessageAt, cutoff),
        ),
      );

    for (const { conversation, agent } of stale) {
      const [alert] = await db
        .insert(alerts)
        .values({
          conversationId: conversation.id,
          type: 'inactivity',
          detail: `no agent response for ${minutes}m`,
        })
        .returning();
      await db
        .update(conversations)
        .set({ state: 'needs_human' })
        .where(eq(conversations.id, conversation.id));
      const n = await alertNotification(db, alert, conversation, agent);
      bus.publish(agent.workspaceId, {
        type: 'alert',
        data: { ...toAlert(alert), notification: n },
      });
      bus.publish(agent.workspaceId, {
        type: 'conversation',
        data: { id: conversation.id, state: 'needs_human' },
      });
      void notifyWorkspace(db, agent.workspaceId, n);
      fired++;
    }
  }
  return fired;
}

/**
 * SLA re-alerts: for agents with config.sla_minutes, re-notify the workspace
 * when a needs_human conversation stays unclaimed past the SLA. Each breach
 * raises one 'sla' alert; repeat breaches also repost to the Slack alert
 * channel (escalation path). Deduped — at most one sla alert per SLA window.
 */
export async function sweepSla(db: Db): Promise<number> {
  const agentRows = (await db.select().from(agents)).filter(
    (a) => (a.config as { sla_minutes?: number } | null)?.sla_minutes,
  );
  let fired = 0;
  for (const agent of agentRows) {
    const slaMinutes = (agent.config as { sla_minutes: number }).sla_minutes;
    const cutoff = new Date(Date.now() - slaMinutes * 60_000);
    const stale = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.state, 'needs_human'),
        ),
      );

    for (const conv of stale) {
      // handoff age = the newest open non-sla alert (fallback: last activity)
      const [anchor] = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.conversationId, conv.id),
            ne(alerts.type, 'sla'),
            eq(alerts.status, 'open'),
          ),
        )
        .orderBy(desc(alerts.createdAt))
        .limit(1);
      const handoffAt = anchor?.createdAt ?? conv.lastMessageAt ?? conv.createdAt;
      if (handoffAt > cutoff) continue; // still within the SLA window

      // at most one re-alert per SLA window
      const [lastSla] = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'sla')))
        .orderBy(desc(alerts.createdAt))
        .limit(1);
      if (lastSla && lastSla.createdAt > cutoff) continue;

      const ageMin = Math.round((Date.now() - handoffAt.getTime()) / 60_000);
      const escalated = Boolean(lastSla); // 2nd+ breach → escalate to Slack
      const [alert] = await db
        .insert(alerts)
        .values({
          conversationId: conv.id,
          type: 'sla',
          detail: `unclaimed for ${ageMin}m (SLA ${slaMinutes}m)${escalated ? ' — escalated' : ''}`,
        })
        .returning();
      const n = await alertNotification(db, alert, conv, agent);
      bus.publish(agent.workspaceId, {
        type: 'alert',
        data: { ...toAlert(alert), notification: n },
      });
      // SLA breaches page the whole workspace even when assigned — the point
      // of the escalation is that the owner didn't respond
      void notifyWorkspace(db, agent.workspaceId, n);
      if (escalated) {
        void postSlackAlert(db, agent.workspaceId, conv, agent, alert);
      }
      fired++;
    }
  }
  return fired;
}
