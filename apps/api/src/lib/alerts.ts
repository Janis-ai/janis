import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations } from '../db/schema.js';
import { bus } from './bus.js';
import { toAlert } from './serializers.js';
import { alertNotification, notifyWorkspace, type NotifyEvent } from './notify.js';
import { postSlackAlert } from './slack.js';

type AlertRow = typeof alerts.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ConvRow = typeof conversations.$inferSelect;

/**
 * Insert an open alert unless one already exists for this conversation+type.
 * The partial unique index `alerts_one_open_per_type` makes this safe under
 * concurrent event processing — the loser gets the winner's row back with
 * `created: false` and should skip publish/notify (already handled there).
 */
export async function openAlertOnce(
  db: Db,
  values: { conversationId: string; type: AlertRow['type']; detail?: string },
): Promise<{ alert: AlertRow; created: true } | { alert: AlertRow | undefined; created: false }> {
  const [inserted] = await db
    .insert(alerts)
    .values(values)
    .onConflictDoNothing({
      target: [alerts.conversationId, alerts.type],
      where: eq(alerts.status, 'open'),
    })
    .returning();
  if (inserted) return { alert: inserted, created: true };
  const [existing] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.conversationId, values.conversationId),
        eq(alerts.type, values.type),
        eq(alerts.status, 'open'),
      ),
    )
    .limit(1);
  // Conflict happened but the winner's row is gone — the conversation was
  // deleted (or the alert resolved) between the two statements. Treat as a
  // no-op rather than resurrect it.
  if (!existing) return { alert: undefined, created: false };
  return { alert: existing, created: false };
}

/**
 * Resolve all open alerts on a conversation (optionally one type) and
 * republish each over the bus — every open client clears the dot without
 * waiting for an unrelated event. Returns the resolved rows so callers can
 * note/count them. The one implementation of this sweep — don't inline it.
 */
export async function resolveOpenAlerts(
  db: Db,
  workspaceId: string,
  conversationId: string,
  type?: AlertRow['type'],
): Promise<AlertRow[]> {
  const conds = [
    eq(alerts.conversationId, conversationId),
    eq(alerts.status, 'open'),
  ];
  if (type) conds.push(eq(alerts.type, type));
  const resolved = await db
    .update(alerts)
    .set({ status: 'resolved' })
    .where(and(...conds))
    .returning();
  for (const a of resolved) {
    bus.publish(workspaceId, { type: 'alert', data: toAlert(a) });
  }
  return resolved;
}

/**
 * Deliver a freshly created alert: build the notification payload, publish
 * the alert event (with the notification attached for inbox consumers), post
 * to the Slack alert channel, and fan out push/email per notify prefs. The
 * one tail every alert-creation path shares — call it after openAlertOnce
 * returns `created`, not before.
 */
export async function dispatchAlert(
  db: Db,
  agent: AgentRow,
  conv: ConvRow,
  alert: AlertRow,
  opts: { userIds?: string[]; event?: NotifyEvent } = {},
): Promise<void> {
  const n = await alertNotification(db, alert, conv, agent);
  bus.publish(agent.workspaceId, {
    type: 'alert',
    data: { ...toAlert(alert), notification: n },
  });
  void postSlackAlert(db, agent.workspaceId, conv, agent, alert).catch(() => {});
  void notifyWorkspace(db, agent.workspaceId, n, {
    agentId: agent.id,
    userIds: opts.userIds,
    event: opts.event,
  }).catch(() => {});
}
