import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, conversations, messages } from '../db/schema.js';
import { bus } from './bus.js';
import { llmFor, type LlmSettings } from './llm.js';

import { DEFAULT_INTENTS } from '@janis/shared';

/** One cheap chat completion — classify the opener into a taxonomy label. */
export async function classifyIntent(
  llm: LlmSettings,
  text: string,
  labels: string[],
): Promise<string | null> {
  if (!llm.apiKey || !text.trim()) return null;
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
      ...(llm.headers ?? {}),
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 8,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Classify the customer message into exactly one label from this list: ' +
            labels.join(', ') +
            '. Reply with the label only — no punctuation, no explanation.',
        },
        { role: 'user', content: text.slice(0, 2000) },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = (body.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
  if (!raw) return null;
  // Exact match first, then a contains-match for labels the model decorated.
  const exact = labels.find((l) => l.toLowerCase() === raw);
  if (exact) return exact;
  const loose = labels.find((l) => raw.includes(l.toLowerCase()));
  return loose ?? 'other';
}

/**
 * Classify a conversation's opener and apply intent-matched routing rules.
 * Runs off the ingest hot path (callers `void` it) — a slow LLM must never
 * delay the reply. Classifies once: a stored 'other' is still a verdict.
 */
export async function classifyAndRoute(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  text: string,
  /** BYO agents may pass payload.intent — trusted verbatim, no LLM call. */
  knownIntent?: string | null,
): Promise<void> {
  let intent = knownIntent?.slice(0, 60) ?? null;
  if (!intent) {
    const cfg = (agent.config ?? {}) as { intents?: string[] };
    const labels = cfg.intents?.length ? cfg.intents : DEFAULT_INTENTS;
    let llm: LlmSettings;
    try {
      llm = await llmFor(db, agent);
    } catch {
      return; // unpriced/no LLM — leave unclassified, don't block the pipeline
    }
    intent = await classifyIntent(llm, text, labels).catch(() => null);
  }
  if (!intent) return;

  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.agentId, agent.id));

  // Intent routing — rules whose intents list names this label. Non-stealing
  // like keyword routing: only fills an unassigned thread.
  const actions = rules
    .map((r) => ({ r, c: r.config as { intents?: string[]; assign_to?: string; tag?: string; enabled?: boolean } }))
    .filter(({ c }) => c.enabled !== false && (c.intents ?? []).some((i) => i.toLowerCase() === intent.toLowerCase()));
  const assignTo = actions.map((a) => a.c.assign_to).find(Boolean);
  const tags = actions.map((a) => a.c.tag).filter((t): t is string => !!t);

  const [updated] = await db
    .update(conversations)
    .set({
      intent,
      intentSource: knownIntent ? 'byo' : 'ai',
      intentCheckedAt: new Date(),
      ...(assignTo && !conv.assigneeId ? { assigneeId: assignTo } : {}),
      ...(tags.length ? { tags: [...new Set([...conv.tags, ...tags])] } : {}),
    })
    .where(eq(conversations.id, conv.id))
    .returning();
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: updated.id, state: updated.state },
  });
}

/** Drift re-check — a conversation that opened as "billing" can turn into
 * "cancellation" ten turns in, and the opener's label goes stale. Re-classify
 * the last few customer messages; a differing label updates the intent and
 * re-fires that intent's rule tags (assignment still never steals). Runs at
 * most once per conversation per 15 min; 'manual'/'byo' labels are never
 * touched, and a window classified 'other' is treated as noise, not drift. */
export async function recheckIntent(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
): Promise<void> {
  if (!conv.intent || conv.intentSource !== 'ai') return;
  if (conv.intentCheckedAt && Date.now() - conv.intentCheckedAt.getTime() < 15 * 60_000)
    return;
  // Stamp first so a slow LLM never lets two inbounds race the check.
  await db
    .update(conversations)
    .set({ intentCheckedAt: new Date() })
    .where(eq(conversations.id, conv.id));

  const window = await db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')))
    .orderBy(desc(messages.createdAt))
    .limit(4);
  const text = window
    .reverse()
    .map((m) => m.text ?? '')
    .join('\n');
  if (!text.trim()) return;

  const cfg = (agent.config ?? {}) as { intents?: string[] };
  const labels = cfg.intents?.length ? cfg.intents : DEFAULT_INTENTS;
  let llm: LlmSettings;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return;
  }
  const next = await classifyIntent(llm, text, labels).catch(() => null);
  if (!next || next === conv.intent || next === 'other') return;

  // Re-fire the new intent's rule tags; assignment still only fills an
  // empty slot so a mid-conversation drift can't steal someone's queue.
  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.agentId, agent.id));
  const tags = rules
    .map((r) => r.config as { intents?: string[]; tag?: string; enabled?: boolean })
    .filter((c) => c.enabled !== false && (c.intents ?? []).some((i) => i.toLowerCase() === next.toLowerCase()))
    .map((c) => c.tag)
    .filter((t): t is string => !!t);

  const [updated] = await db
    .update(conversations)
    .set({
      intent: next,
      ...(tags.length ? { tags: [...new Set([...conv.tags, ...tags])] } : {}),
    })
    .where(eq(conversations.id, conv.id))
    .returning();
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: updated.id, state: updated.state },
  });
}
