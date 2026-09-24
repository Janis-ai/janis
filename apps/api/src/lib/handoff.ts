import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages } from '../db/schema.js';
import { bus } from './bus.js';
import { llmFor } from './llm.js';
import { alertNotification, notifyWorkspace } from './notify.js';
import { toAlert, toMessage } from './serializers.js';
import { postSlackAlert } from './slack.js';
import { recordLlmUsage } from './usage.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

const HANDOFF_BRIEF_SYSTEM =
  'You write handoff briefs for human support operators. In one or two sentences, summarize the conversation and what the customer needs help with right now. Be specific about the ask (order numbers, account changes, error messages). Output only the brief.';

function line(m: { direction: string; text: string | null; flags: unknown }): string | null {
  if (!m.text) return null;
  const f = m.flags as {
    failure?: boolean;
    help_requested?: boolean;
    custom_alert?: boolean;
    handoff_offer?: boolean;
  };
  if (f?.failure || f?.help_requested || f?.custom_alert) return '(passed to a human teammate)';
  if (f?.handoff_offer) return '(offered a human teammate — awaiting their reply)';
  if (m.direction === 'human') return `human operator: ${m.text}`;
  return m.direction === 'in' ? `customer: ${m.text}` : `agent: ${m.text}`;
}

/**
 * One-shot brief for a handoff moment: rolling summary + recent messages +
 * the handoff reason → "customer needs X". Null without an LLM — callers
 * fall back to the raw reason.
 */
export async function summarizeHandoff(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  reason?: string,
): Promise<string | null> {
  const llm = llmFor(agent);
  if (!llm.apiKey) return null;
  const rows = await db
    .select({ direction: messages.direction, text: messages.text, flags: messages.flags })
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(desc(messages.createdAt))
    .limit(15);
  const transcript = rows.reverse().map(line).filter(Boolean).join('\n').slice(-6000);
  const prompt = [
    conv.agentSummary ? `Earlier context: ${conv.agentSummary}` : null,
    transcript ? `Recent messages:\n${transcript}` : null,
    `The automated agent just requested a human${reason ? ` (reason: ${reason})` : ''}.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 120,
      messages: [
        { role: 'system', content: HANDOFF_BRIEF_SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  await recordLlmUsage(db, {
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    conversationId: conv.id,
    model: llm.model,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  });
  return json.choices?.[0]?.message?.content?.trim() || null;
}

/**
 * Enrich a handoff moment: summarize what the customer needs, then
 *  - store it on the handoff note's payload (each moment keeps its own brief)
 *  - update the open help_request alert's detail
 *  - notify operators (push/email/Slack) — only for newly-opened alerts,
 *    since repeat handoffs while one's open shouldn't re-notify
 */
export async function enrichHandoff(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  note: MessageRow,
  alertId: string | undefined,
  isNewAlert: boolean,
  reason?: string,
  assigneeId?: string | null,
): Promise<void> {
  try {
    const summary = await summarizeHandoff(db, agent, conv, reason).catch(() => null);

    if (summary) {
      const payload = { ...(note.payload as Record<string, unknown>), summary };
      await db.update(messages).set({ payload }).where(eq(messages.id, note.id));
      bus.publish(agent.workspaceId, {
        type: 'message',
        data: toMessage({ ...note, payload }),
      });
      if (alertId) {
        const [a] = await db
          .update(alerts)
          .set({ detail: reason ? `${reason} — ${summary}` : summary })
          .where(eq(alerts.id, alertId))
          .returning();
        if (a) {
          bus.publish(agent.workspaceId, {
            type: 'alert',
            data: { ...toAlert(a), notification: await alertNotification(db, a, conv, agent) },
          });
        }
      }
    }

    if (isNewAlert && alertId) {
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
      if (!alert) return;
      void postSlackAlert(db, agent.workspaceId, conv, agent, alert);
      void notifyWorkspace(
        db,
        agent.workspaceId,
        await alertNotification(db, alert, conv, agent, summary ?? reason),
        { userIds: assigneeId ? [assigneeId] : undefined },
      );
    }
  } catch {
    // enrichment is best-effort — the alert already exists regardless
  }
}
