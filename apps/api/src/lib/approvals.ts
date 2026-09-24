import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, pendingActions } from '../db/schema.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';
import { loadSecretsMap } from './secrets.js';
import { connectionSecrets } from './connections.js';
import { callTool, type ToolDef } from './toolExec.js';

type PendingAction = typeof pendingActions.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

const RESULT_PREVIEW = 400;

/**
 * A gated tool call — park it as a pending action instead of executing.
 * Returns the tool-result string the model sees; the transcript card and
 * Slack approval buttons let a teammate decide.
 */
export async function requestToolApproval(
  db: Db,
  agent: AgentRow,
  convId: string,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<string> {
  // Same conv + tool + args already awaiting a decision — don't stack cards.
  const existing = await db
    .select()
    .from(pendingActions)
    .where(
      and(eq(pendingActions.conversationId, convId), eq(pendingActions.status, 'pending')),
    );
  if (
    existing.some(
      (p) => p.toolName === tool.name && JSON.stringify(p.args) === JSON.stringify(args),
    )
  ) {
    return 'pending_approval: this exact action is already awaiting teammate approval — tell the customer it is still being confirmed, and do not claim it is done';
  }

  const [action] = await db
    .insert(pendingActions)
    .values({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      conversationId: convId,
      toolName: tool.name,
      tool: tool as never,
      args: args as never,
    })
    .returning();

  const [row] = await db
    .insert(messages)
    .values({
      conversationId: convId,
      direction: 'human',
      text: `approval requested — ${tool.name}`,
      flags: { action_request: true },
      payload: {
        internal: true,
        event: 'approval requested',
        action: { id: action.id, tool: tool.name, args, status: 'pending' },
      },
    })
    .returning();
  await db
    .update(pendingActions)
    .set({ messageId: row.id })
    .where(eq(pendingActions.id, action.id));

  bus.publish(agent.workspaceId, { type: 'message', data: toMessage(row) });
  // Lazy import — slack.ts already pulls hostedAgent in; keeping this dynamic
  // avoids a module cycle.
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (conv) {
    const { postSlackActionRequest } = await import('./slack.js');
    await postSlackActionRequest(db, conv, agent, action).catch(() => {});
  }

  return 'pending_approval: submitted to a human teammate for approval — do NOT tell the customer it is done; say the team is confirming it';
}

/**
 * Approve or deny a pending action. Approved actions execute immediately and
 * the outcome lands in the transcript; the caller resumes the agent so it can
 * close the loop with the customer.
 */
export async function decidePendingAction(
  db: Db,
  actionId: string,
  decidedBy: { id: string; name: string },
  approve: boolean,
): Promise<{ action: PendingAction; conv: ConversationRow; agent: AgentRow } | 'not-pending' | null> {
  const [action] = await db
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, actionId))
    .limit(1);
  if (!action) return null;
  if (action.status !== 'pending') return 'not-pending';

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, action.conversationId))
    .limit(1);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, action.agentId))
    .limit(1);
  if (!conv || !agent) return null;

  let result: string | null = null;
  if (approve) {
    const secrets = {
      ...(await loadSecretsMap(db, agent.id)),
      ...(await connectionSecrets(db, agent.id)),
    };
    result = await callTool(
      action.tool as ToolDef,
      action.args as Record<string, unknown>,
      secrets,
    ).catch((err) => `error: ${err instanceof Error ? err.message : 'tool failed'}`);
  }

  const [updated] = await db
    .update(pendingActions)
    .set({
      status: approve ? 'approved' : 'denied',
      result,
      decidedById: decidedBy.id,
      decidedByName: decidedBy.name,
      decidedAt: new Date(),
    })
    .where(eq(pendingActions.id, action.id))
    .returning();

  const preview = result ? result.slice(0, RESULT_PREVIEW) : null;
  const resultText = approve
    ? `teammate approved and ran ${action.toolName}${preview ? ` — result: ${preview}` : ''}`
    : `teammate declined the action ${action.toolName} — do not retry it; tell the customer it could not be done`;

  // Resolve the request card in place so console renders the outcome.
  if (action.messageId) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, action.messageId))
      .limit(1);
    if (msg) {
      const p = (msg.payload ?? {}) as Record<string, unknown>;
      const a = (p.action ?? {}) as Record<string, unknown>;
      const [upd] = await db
        .update(messages)
        .set({
          payload: {
            ...p,
            action: {
              ...a,
              status: updated.status,
              decided_by: decidedBy.name,
              ...(preview ? { result: preview } : {}),
            },
          },
        })
        .where(eq(messages.id, msg.id))
        .returning();
      bus.publish(agent.workspaceId, { type: 'message', data: toMessage(upd) });
    }
  }

  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'human',
      text: resultText,
      flags: { action_result: true },
      payload: { internal: true, event: approve ? 'action approved' : 'action denied' },
      authorId: decidedBy.id,
    })
    .returning();
  bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });

  const { resolveSlackActionCards } = await import('./slack.js');
  await resolveSlackActionCards(db, updated, approve, decidedBy.name).catch(() => {});

  return { action: updated, conv, agent };
}
