import { eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts, conversations } from '../db/schema.js';
import { agentScopeCond, type AgentScope } from './access.js';

/** Query params shared by the conversation list and search endpoints —
 * 'unread'/'starred' are flags and 'handoff_offer'/'failure' are open-alert
 * signals — all ride the same param as the four real lifecycle states. */
export const convListQuery = z.object({
  state: z
    .enum(['active', 'needs_human', 'human', 'archived', 'snoozed', 'unread', 'starred', 'handoff_offer', 'failure', 'overdue'])
    .optional(),
  agent_id: z.string().uuid().optional(),
  attention: z.enum(['1', 'true']).optional(), // needs_human OR has open alerts
  assignee: z.enum(['me']).optional(), // only conversations assigned to the caller
  // Reports drill-down: ?intent=support groups by classified topic
  // ('unclassified' = intent is null); ?from/?to bound created_at — a plain
  // YYYY-MM-DD `to` is inclusive (shifts to exclusive end-of-day).
  intent: z.string().trim().min(1).max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]|$)/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]|$)/).optional(),
  // Cursor pagination: `${epochMs}_${uuid}` of the last row's sort key
  // (coalesce(last_message_at, created_at), id). Stable under new arrivals —
  // new rows sort ahead of the cursor, never inside a fetched window.
  cursor: z
    .string()
    .regex(/^\d+_[0-9a-fA-F-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** WHERE conditions for conversation listing — workspace scope + filters.
 * Shared by /api/conversations and /api/search so filters behave identically. */
export function convListConditions(
  q: z.infer<typeof convListQuery>,
  workspaceId: string,
  userId: string,
  scope?: AgentScope,
): SQL[] {
  const scoped = agentScopeCond(scope ?? null);
  const conditions: SQL[] = [eq(agents.workspaceId, workspaceId), ...(scoped ? [scoped] : [])];
  if (q.state === 'unread') conditions.push(eq(conversations.isUnread, true));
  else if (q.state === 'starred') conditions.push(eq(conversations.isStarred, true));
  else if (q.state === 'handoff_offer' || q.state === 'failure')
    // signal filter: any open alert of that type, whatever the lifecycle state
    conditions.push(
      sql`exists (
        select 1 from ${alerts}
        where ${alerts.conversationId} = ${conversations.id}
          and ${alerts.status} = 'open'
          and ${alerts.type} = ${q.state}
      )`,
    );
  else if (q.state === 'overdue')
    // still waiting on a human past the agent's SLA — same definition the
    // Reports handoff card uses (config.sla_minutes, default 15)
    conditions.push(
      eq(conversations.state, 'needs_human'),
      sql`exists (
        select 1 from ${alerts}
        where ${alerts.conversationId} = ${conversations.id}
          and ${alerts.status} = 'open'
          and ${alerts.createdAt} < now() - interval '1 minute' * coalesce((${agents.config} ->> 'sla_minutes')::int, 15)
      )`,
    );
  else if (q.state === 'snoozed')
    // pseudo-state: snoozed is orthogonal to lifecycle — anything snoozed
    // into the future, whatever its real state
    conditions.push(sql`${conversations.snoozedUntil} > now()`);
  else if (q.state) conditions.push(eq(conversations.state, q.state));
  // archived hidden unless filtered — but a topic drill-down wants the whole
  // window (resolved convs are archived), so intent/from/to imply inclusion
  else if (!q.intent && !q.from && !q.to) conditions.push(ne(conversations.state, 'archived'));
  // actively-snoozed conversations hide from every queue except the Snoozed
  // view itself (and archived — archive wins over snooze); drill-downs count
  // everything in the window, snoozed or not
  if (q.state !== 'snoozed' && q.state !== 'archived' && !q.intent && !q.from && !q.to) {
    conditions.push(
      sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
    );
  }
  if (q.agent_id) conditions.push(eq(conversations.agentId, q.agent_id));
  if (q.intent)
    conditions.push(
      q.intent === 'unclassified'
        ? isNull(conversations.intent)
        : eq(conversations.intent, q.intent),
    );
  if (q.from) {
    const d = new Date(q.from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(conversations.createdAt, d));
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!Number.isNaN(d.getTime()))
      conditions.push(
        lt(conversations.createdAt, /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(d.getTime() + 86_400_000) : d),
      );
  }
  if (q.assignee === 'me') conditions.push(eq(conversations.assigneeId, userId));
  if (q.attention) {
    conditions.push(inArray(conversations.state, ['needs_human', 'human']));
  }
  return conditions;
}
