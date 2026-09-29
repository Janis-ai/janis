import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, conversations } from '../db/schema.js';
import { bus } from './bus.js';
import { llmFor, type LlmSettings } from './llm.js';

/** Fallback taxonomy when the agent doesn't define its own intent labels. */
export const DEFAULT_INTENTS = [
  'billing',
  'shipping',
  'order status',
  'returns',
  'technical issue',
  'account',
  'cancellation',
  'sales',
  'feedback',
  'other',
];

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
