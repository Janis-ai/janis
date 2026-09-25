import { eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts, conversations } from '../db/schema.js';

/** Query params shared by the conversation list and search endpoints —
 * 'unread'/'starred' are flags and 'handoff_offer'/'failure' are open-alert
 * signals — all ride the same param as the four real lifecycle states. */
export const convListQuery = z.object({
  state: z
    .enum(['active', 'needs_human', 'human', 'archived', 'unread', 'starred', 'handoff_offer', 'failure'])
    .optional(),
  agent_id: z.string().uuid().optional(),
  attention: z.enum(['1', 'true']).optional(), // needs_human OR has open alerts
  assignee: z.enum(['me']).optional(), // only conversations assigned to the caller
});

/** WHERE conditions for conversation listing — workspace scope + filters.
 * Shared by /api/conversations and /api/search so filters behave identically. */
export function convListConditions(
  q: z.infer<typeof convListQuery>,
  workspaceId: string,
  userId: string,
): SQL[] {
  const conditions: SQL[] = [eq(agents.workspaceId, workspaceId)];
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
  else if (q.state) conditions.push(eq(conversations.state, q.state));
  else conditions.push(ne(conversations.state, 'archived')); // archived hidden unless filtered
  if (q.agent_id) conditions.push(eq(conversations.agentId, q.agent_id));
  if (q.assignee === 'me') conditions.push(eq(conversations.assigneeId, userId));
  if (q.attention) {
    conditions.push(inArray(conversations.state, ['needs_human', 'human']));
  }
  return conditions;
}
