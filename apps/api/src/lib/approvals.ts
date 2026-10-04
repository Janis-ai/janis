import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, alerts, conversations, messages, pendingActions } from '../db/schema.js';
import { bus } from './bus.js';
import { dispatchAlert, openAlertOnce, resolveOpenAlerts } from './alerts.js';
import { transitionConversation } from './conversationOps.js';
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
    return 'pending_approval: this exact action is already awaiting approval — an open card sits in the chat; tell them it is still pending their decision, and do not claim it is done';
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
    // A parked approval is as urgent as a handoff — flag the conversation and
    // page operators through the standard alert pipeline so it surfaces in
    // the attention tab, badges, toasts, push/email and the Slack channel.
    const detail = `agent wants to run ${tool.name} — approve or deny in the conversation`;
    const [openAlert] = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.conversationId, convId),
          eq(alerts.type, 'approval_request'),
          eq(alerts.status, 'open'),
        ),
      )
      .limit(1);
    if (openAlert) {
      // Another gated call while one is pending — keep the single alert but
      // name the newest request.
      await db.update(alerts).set({ detail }).where(eq(alerts.id, openAlert.id));
    } else {
      const { alert, created } = await openAlertOnce(db, {
        conversationId: convId,
        type: 'approval_request',
        detail,
      });
      if (!created) {
        if (alert) await db.update(alerts).set({ detail }).where(eq(alerts.id, alert.id));
      } else {
        await dispatchAlert(db, agent, conv, alert, {
          userIds: conv.assigneeId ? [conv.assigneeId] : undefined,
          event: 'approval',
        });
      }
    }
    // needs_human is an attention flag only — the agent still replies while
    // the action awaits a decision. Human-owned threads stay human-owned.
    if (conv.state === 'active' || conv.state === 'archived') {
      await transitionConversation(db, agent.workspaceId, conv, 'needs_human', {
        cause: 'approval pending',
      });
      conv.state = 'needs_human';
    }
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

  // Concierge action cards store a builtin descriptor ({builtin: name})
  // instead of a webhook ToolDef — dispatch into BUILTIN_TOOLS in-process.
  const snap = action.tool as { builtin?: unknown };
  const builtinName = typeof snap.builtin === 'string' ? snap.builtin : null;

  let result: string | null = null;
  if (approve) {
    if (builtinName) {
      const { BUILTIN_TOOLS } = await import('./builtinTools.js');
      const b = BUILTIN_TOOLS.find((x) => x.name === builtinName);
      // Parked args pass through verbatim — String()-coercing turns object
      // args (apply_save_widget's spec, apply_agent_config's patch,
      // apply_routing_rule's config) into "[object Object]". Executors
      // already String() scalar fields they read.
      result = b
        ? await b
            .run(action.args as Record<string, string>, {
              db,
              convId: conv.id,
              workspaceId: action.workspaceId,
            })
            .catch((err) => `error: ${err instanceof Error ? err.message : 'tool failed'}`)
        : `error: unknown builtin ${builtinName}`;
    } else {
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
  // Builtin executors return JSON carrying `summary` — a one-line readable
  // outcome ("Added to Acme Returns' knowledge: …"). The card shows that
  // instead of the raw result blob; webhook ToolDef bodies keep the
  // truncated preview as before.
  const summary = (() => {
    if (!result) return null;
    try {
      const p = JSON.parse(result) as { summary?: unknown };
      return typeof p.summary === 'string' ? p.summary : null;
    } catch {
      return null;
    }
  })();
  const cardResult = summary ?? preview;
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
              ...(cardResult ? { result: cardResult } : {}),
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

  // Concierge cards live in the Ask Janis thread, where the resumed agent
  // turn can be slow or emit nothing — a decision read as typing dots that
  // never resolve. Post a deterministic confirmation line instead. Applies
  // to every decision on a concierge thread, not just builtin executors —
  // webhook-tool cards parked there are decided the same way.
  if (env.operatorWorkspaceId && action.workspaceId === env.operatorWorkspaceId) {
    const failed = approve && result !== null && result.startsWith('error:');
    const confirm = !approve
      ? 'Dismissed — no changes made.'
      : failed
        ? `The action failed — ${(cardResult ?? 'unknown error').replace(/^error:\s*/i, '')}`
        : `Done — ${cardResult ?? 'the change was applied.'}`;
    const [out] = await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'out', text: confirm })
      .returning();
    bus.publish(agent.workspaceId, { type: 'message', data: toMessage(out) });
  }

  const { resolveSlackActionCards } = await import('./slack.js');
  await resolveSlackActionCards(db, updated, approve, decidedBy.name).catch(() => {});

  // Nothing left awaiting a decision — close the approval alert. The
  // needs_human flag drops back to active only when no other open alert
  // still needs a human; a human-owned thread stays human-owned either way.
  const [stillPending] = await db
    .select({ id: pendingActions.id })
    .from(pendingActions)
    .where(
      and(eq(pendingActions.conversationId, conv.id), eq(pendingActions.status, 'pending')),
    )
    .limit(1);
  if (!stillPending) {
    await resolveOpenAlerts(db, agent.workspaceId, conv.id, 'approval_request');
    if (conv.state === 'needs_human') {
      const [otherOpen] = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(eq(alerts.conversationId, conv.id), eq(alerts.status, 'open')))
        .limit(1);
      if (!otherOpen) {
        await transitionConversation(db, agent.workspaceId, conv, 'active', {
          cause: 'all approvals decided',
        });
        conv.state = 'active';
      }
    }
  }

  return { action: updated, conv, agent };
}
