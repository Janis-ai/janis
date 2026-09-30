import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, alerts, busEvents, conversations, knowledgeFiles, messages, rateLimits, sweeperLocks, typingState, webhookDeliveries } from '../db/schema.js';
import { bus, INSTANCE_ID } from '../lib/bus.js';
import { openAlertOnce } from '../lib/alerts.js';
import { alertNotification, notifyWorkspace } from '../lib/notify.js';
import { opsAlert } from '../lib/opsAlert.js';
import { inactivityActions, inactivityThresholds } from '../lib/rules.js';
import { toAlert, toMessage } from '../lib/serializers.js';
import { mirrorToSlack, postSlackAlert } from '../lib/slack.js';
import { resume } from './takeover.js';
import { renewGmailWatches, sweepGmail } from './gmailSweep.js';
import { renewOutlookWatches, sweepOutlook } from './outlookSweep.js';
import { sweepWebhookRetries } from '../lib/webhooks.js';
import { runJobs, enqueueJob } from '../lib/jobs.js';
import { sweepCampaigns } from '../lib/campaigns.js';
import { sweepEvals } from '../lib/evalRuns.js';

/**
 * Claim or renew a named singleton lock. Only the holder (or anyone, once the
 * row expires) wins the upsert — lets every instance run its own ticker while
 * exactly one does the work per interval.
 */
export async function acquireLock(
  db: Db,
  name: string,
  ttlMs: number,
  holder = INSTANCE_ID,
): Promise<boolean> {
  // ISO string, not Date — postgres-js can't serialize Date bind params on
  // drizzle's prepared-statement execute path (ERR_INVALID_ARG_TYPE). This
  // silently killed every sweep under DATABASE_URL; never bind Date here.
  const until = new Date(Date.now() + ttlMs).toISOString();
  const res = (await db.execute(sql`
    insert into sweeper_locks (name, holder, expires_at)
    values (${name}, ${holder}, ${until})
    on conflict (name) do update
      set holder = ${holder}, expires_at = ${until}
      where sweeper_locks.holder = ${holder}
         or sweeper_locks.expires_at < now()
    returning name
  `)) as unknown as { rows?: unknown[] } | unknown[];
  // postgres-js execute() is array-like; PGlite wraps rows in a result object.
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.length > 0;
}

/**
 * Periodically (one instance at a time, via the sweeper_locks leader row):
 *  - escalate 'active' conversations where the end user is waiting
 *    (last message inbound) past the agent's inactivity threshold
 *  - auto-release 'human' takeovers past the agent's auto_resume_minutes
 *  - re-alert 'needs_human' conversations unclaimed past the agent's SLA
 *  - wake expired snoozes (resurface as unread — the "reminder" half)
 *  - poll gmail channels, renew gmail push watches, refresh knowledge URLs
 *  - prune transient bus_events rows
 */
export function startSweeper(db: Db, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      let won: boolean;
      try {
        won = await acquireLock(db, 'sweeper', intervalMs * 2);
      } catch (err) {
        // The tick's outer catch used to swallow this entirely — a broken
        // acquireLock (e.g. unserializable bind) left every sweep dead for
        // weeks. Log so it shows up in Cloud Logging.
        console.error('sweeper lock error:', err);
        return;
      }
      if (!won) return;
      void sweep(db).catch((err) => console.error('sweep error:', err));
      void sweepAutoResume(db).catch((err) => console.error('sweepAutoResume error:', err));
      void sweepSla(db).catch((err) => console.error('sweepSla error:', err));
      void sweepGmail(db).catch((err) => console.error('sweepGmail error:', err));
      void renewGmailWatches(db).catch((err) => console.error('renewGmailWatches error:', err));
      void sweepOutlook(db).catch((err) => console.error('sweepOutlook error:', err));
      void renewOutlookWatches(db).catch((err) => console.error('renewOutlookWatches error:', err));
      void sweepKnowledge(db).catch((err) => console.error('sweepKnowledge error:', err));
      void sweepSnoozes(db).catch((err) => console.error('sweepSnoozes error:', err));
      void sweepWebhookRetries(db).catch((err) => console.error('sweepWebhookRetries error:', err));
      void sweepDeliveryFailures(db).catch((err) => console.error('sweepDeliveryFailures error:', err));
      // Queued background work (broadcasts, campaign sends) — sequential,
      // runs off the request path.
      void runJobs(db)
        .then((n) => { if (n) console.log(`jobs: ran ${n}`); })
        .catch((err) => console.error('runJobs error:', err));
      void sweepCampaigns(db).catch((err) => console.error('sweepCampaigns error:', err));
      void sweepEvals(db).catch((err) => console.error('sweepEvals error:', err));
      void db
        .delete(busEvents)
        .where(lt(busEvents.createdAt, new Date(Date.now() - 10 * 60_000)))
        .catch((err) => console.error('busEvents prune error:', err));
      void db
        .delete(rateLimits)
        .where(lt(rateLimits.resetAt, new Date(Date.now() - 3_600_000)))
        .catch((err) => console.error('rateLimits prune error:', err));
      void db
        .delete(typingState)
        .where(lt(typingState.expiresAt, new Date(Date.now() - 60_000)))
        .catch((err) => console.error('typingState prune error:', err));
    })().catch(() => {});
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Platform-health signal for monitoring: when outbound webhook failures spike
 * (a customer's endpoint down, or our egress broken), emit a structured ERROR
 * line that a Cloud Logging log-based alert can match on `janis.alert`. A dead
 * sweeper can't self-report — that's what the public /status probe covers.
 */
export async function sweepDeliveryFailures(db: Db): Promise<void> {
  const since = new Date(Date.now() - 60 * 60_000);
  const rows = await db
    .select({ status: webhookDeliveries.status, n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(gt(webhookDeliveries.createdAt, since))
    .groupBy(webhookDeliveries.status);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const failed = rows.find((r) => r.status === 'failed')?.n ?? 0;
  if (total >= 10 && failed / total > 0.5) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: `janis.alert webhook_delivery_spike: ${failed}/${total} deliveries failed in the last hour`,
        alert: 'webhook_delivery_spike',
        failed,
        total,
      }),
    );
    opsAlert(`🚨 janis: webhook delivery spike — ${failed}/${total} deliveries failed in the last hour`);
  }
}

/** Expired snoozes resurface as unread — the "reminder" half of snooze.
 * Clearing snoozed_until in the same update makes the pass idempotent: a row
 * only matches while actively snoozed, so re-sweeps can't re-flag a
 * conversation the operator already read. Archived threads are skipped —
 * archive wins over snooze. */
export async function sweepSnoozes(db: Db): Promise<number> {
  const due = await db
    .select({
      id: conversations.id,
      state: conversations.state,
      workspaceId: agents.workspaceId,
    })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        lt(conversations.snoozedUntil, new Date()),
        eq(conversations.isUnread, false),
        ne(conversations.state, 'archived'),
      ),
    );
  if (!due.length) return 0;

  await db
    .update(conversations)
    .set({ isUnread: true, snoozedUntil: null })
    .where(inArray(conversations.id, due.map((d) => d.id)));

  for (const d of due) {
    bus.publish(d.workspaceId, {
      type: 'conversation',
      data: { id: d.id, state: d.state },
    });
  }
  return due.length;
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
      const { alert, created } = await openAlertOnce(db, {
        conversationId: conversation.id,
        type: 'inactivity',
        detail: `no agent response for ${minutes}m`,
      });
      if (!created) continue;
      // Automation on the escalation: the rule can route the stale thread to
      // a teammate and tag it — "unanswered 15m → assign to on-call".
      const actions = inactivityActions(rules.filter((r) => r.agentId === agentId));
      const assignTo = actions.find((a) => a.assignTo)?.assignTo;
      const tags = actions.some((a) => a.tag)
        ? [
            ...new Set([
              ...conversation.tags,
              ...actions.map((a) => a.tag).filter((t): t is string => !!t),
            ]),
          ]
        : conversation.tags;
      await db
        .update(conversations)
        .set({
          state: 'needs_human',
          ...(assignTo ? { assigneeId: assignTo } : {}),
          ...(tags.length !== conversation.tags.length ? { tags } : {}),
        })
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
      void notifyWorkspace(db, agent.workspaceId, n, { agentId: agent.id });
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
      const { alert, created } = await openAlertOnce(db, {
        conversationId: conv.id,
        type: 'sla',
        detail: `unclaimed for ${ageMin}m (SLA ${slaMinutes}m)${escalated ? ' — escalated' : ''}`,
      });
      if (created) {
        const n = await alertNotification(db, alert, conv, agent);
        bus.publish(agent.workspaceId, {
          type: 'alert',
          data: { ...toAlert(alert), notification: n },
        });
        // SLA breaches page the whole workspace even when assigned — the point
        // of the escalation is that the owner didn't respond
        void notifyWorkspace(db, agent.workspaceId, n, { agentId: agent.id });
      }
      if (escalated && alert) {
        void postSlackAlert(db, agent.workspaceId, conv, agent, alert);
      }
      fired++;
    }
  }
  return fired;
}

/**
 * Re-crawl URL knowledge sources whose refresh window elapsed — the tick
 * only ENQUEUES a knowledge.refresh job per due file and pushes next_fetch_at
 * out a few minutes as a claim marker (the job handler's success/failure
 * writes the real next slot). Slow crawls run on the jobs path, not inside
 * the sweep; a crashed job re-enqueues on the next tick. Bounded per tick.
 */
export async function sweepKnowledge(db: Db, limit = 5): Promise<number> {
  const due = await db
    .select({ id: knowledgeFiles.id, workspaceId: knowledgeFiles.workspaceId })
    .from(knowledgeFiles)
    .where(and(isNotNull(knowledgeFiles.sourceUrl), lt(knowledgeFiles.nextFetchAt, new Date())))
    .limit(limit);
  for (const file of due) {
    await db
      .update(knowledgeFiles)
      .set({ nextFetchAt: new Date(Date.now() + 5 * 60_000) })
      .where(eq(knowledgeFiles.id, file.id));
    await enqueueJob(db, {
      workspaceId: file.workspaceId,
      type: 'knowledge.refresh',
      payload: { fileId: file.id },
    });
  }
  return due.length;
}
