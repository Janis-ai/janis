import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, conversations, messages, workspaces } from '../db/schema.js';
import { bus } from './bus.js';
import { deliverToChannel } from './channels.js';
import { toMessage } from './serializers.js';
import { fireRuleAlert } from './ruleAlerts.js';
import { ruleEnabled, type RuleConfig } from './rules.js';

const PROMPT =
  "How was your experience? Reply with a rating from 1 (poor) to 5 (great).";
const THANKS = 'Thanks for the feedback!';

type Conv = typeof conversations.$inferSelect;
type CsatBlock = { enabled?: boolean; prompt?: string; thanks?: string };

/**
 * Effective survey settings for a conversation: agent.config.csat overrides
 * workspaces.config.csat field-by-field; anything still unset falls back to
 * the stock prompt. Enabled defaults to true — CSAT has always fired, so an
 * explicit false is the only way off.
 */
export async function csatSettings(
  db: Db,
  agentId: string,
): Promise<{ enabled: boolean; prompt: string; thanks: string }> {
  const [agent] = await db
    .select({ config: agents.config, workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return { enabled: false, prompt: PROMPT, thanks: THANKS };
  const [ws] = await db
    .select({ config: workspaces.config })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);
  const wsCsat =
    ((ws?.config as { csat?: CsatBlock } | null)?.csat ?? {}) as CsatBlock;
  const agCsat =
    ((agent.config as { csat?: CsatBlock } | null)?.csat ?? {}) as CsatBlock;
  return {
    enabled: agCsat.enabled ?? wsCsat.enabled ?? true,
    prompt: agCsat.prompt ?? wsCsat.prompt ?? PROMPT,
    thanks: agCsat.thanks ?? wsCsat.thanks ?? THANKS,
  };
}

/**
 * Post-resolution satisfaction prompt — sent once when an operator archives a
 * conversation that actually had two-way traffic. The customer's next reply is
 * captured as the rating (see captureCsat) instead of reaching the agent.
 */
export async function sendCsatPrompt(db: Db, conv: Conv): Promise<void> {
  if (conv.csatAskedAt) return; // one ask per conversation
  const settings = await csatSettings(db, conv.agentId);
  if (!settings.enabled) return;
  const [exchange] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .limit(1);
  if (!exchange || exchange.n < 2) return; // nobody talked — nothing to rate
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: settings.prompt,
      payload: { via: 'csat' },
    })
    .returning();
  await db
    .update(conversations)
    .set({ csatPending: true, csatAskedAt: new Date() })
    .where(eq(conversations.id, conv.id));
  const [agent] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, conv.agentId))
    .limit(1);
  if (agent) bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
  await deliverToChannel(db, conv.id, settings.prompt, undefined, { messageId: note.id });
}

/** "5", "4!", "3 - ok", "2/5" → rating; anything else → not a rating. */
export function parseCsatRating(text: string): number | null {
  const m = /^\s*([1-5])(?=\s|[^\d]|$)/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Consume an inbound reply as a CSAT rating when the conversation has a
 * pending prompt. A non-rating reply just clears the prompt and flows on to
 * the agent normally.
 */
export async function captureCsat(db: Db, conv: Conv, text: string): Promise<boolean> {
  if (!conv.csatPending) return false;
  const score = parseCsatRating(text);
  await db
    .update(conversations)
    .set({ csatPending: false, ...(score !== null ? { csatScore: score } : {}) })
    .where(and(eq(conversations.id, conv.id), eq(conversations.csatPending, true)));
  if (score === null) return false;
  // Low-score rules — a bad rating pages whoever the rule routes to while
  // the thread is still warm. Opt-in; no rule, no alert, no extra queries.
  const [agentRow] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, conv.agentId))
    .limit(1);
  if (agentRow) {
    const fired = (
      await db.select().from(alertRules).where(eq(alertRules.agentId, conv.agentId))
    ).filter(
      (r) =>
        r.kind === 'csat' &&
        ruleEnabled(r) &&
        score <= ((r.config as RuleConfig).max_score ?? 3),
    );
    if (fired.length) {
      await fireRuleAlert(db, agentRow, { ...conv, csatScore: score }, {
        type: 'csat',
        detail: `customer rated the conversation ${score}/5`,
        rules: fired,
      }).catch((err) => console.error('[csat] low-score alert failed:', err));
    }
  }
  const settings = await csatSettings(db, conv.agentId);
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: settings.thanks,
      payload: { via: 'csat', score },
    })
    .returning();
  const [agent] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, conv.agentId))
    .limit(1);
  if (agent) bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
  await deliverToChannel(db, conv.id, settings.thanks, undefined, { messageId: note.id });
  return true;
}
