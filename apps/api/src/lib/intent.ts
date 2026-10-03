import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, conversations, messages } from '../db/schema.js';
import { bus } from './bus.js';
import { llmFor, type LlmSettings } from './llm.js';
import { fireRuleAlert } from './ruleAlerts.js';
import { intentMatches, ruleEnabled, type RuleConfig } from './rules.js';

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

/** One cheap chat completion — read the customer's tone. Only runs when a
 *  sentiment rule exists, so agents without one pay nothing. */
export async function classifySentiment(
  llm: LlmSettings,
  text: string,
): Promise<'positive' | 'neutral' | 'negative' | null> {
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
            'Read the customer message and classify their sentiment as exactly one of: positive, neutral, negative. ' +
            'Negative means frustrated, angry, or upset — not merely asking for help. ' +
            'Reply with the label only — no punctuation, no explanation.',
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
  if (raw === 'positive' || raw === 'neutral' || raw === 'negative') return raw;
  return null;
}

/** Sentiment rules enabled on this agent — the gate for classifySentiment. */
function sentimentRules(rules: (typeof alertRules.$inferSelect)[]) {
  return rules.filter((r) => r.kind === 'sentiment' && ruleEnabled(r));
}

/** Fire sentiment rules on a negative read — shared by the opener
 *  classification and the drift re-check. */
async function checkSentiment(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  llm: LlmSettings,
  rules: (typeof alertRules.$inferSelect)[],
  text: string,
): Promise<void> {
  const fired = sentimentRules(rules);
  if (!fired.length) return;
  const s = await classifySentiment(llm, text).catch(() => null);
  if (s !== 'negative') return;
  await fireRuleAlert(db, agent, conv, {
    type: 'sentiment',
    detail: 'customer sentiment classified negative',
    rules: fired,
  }).catch((err) => console.error('[intent] sentiment alert failed:', err));
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
  // Rules come first — enabled sentiment rules gate a second classification
  // call on the same opener, so they're needed before the LLM is fetched.
  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.agentId, agent.id));

  let intent = knownIntent?.slice(0, 60) ?? null;
  let llm: LlmSettings | null = null;
  if (!intent || sentimentRules(rules).length) {
    try {
      llm = await llmFor(db, agent);
    } catch {
      llm = null; // unpriced/no LLM — classification silently skipped
    }
  }
  if (!intent) {
    if (!llm) return; // no LLM and nothing BYO'd — leave unclassified
    const cfg = (agent.config ?? {}) as { intents?: string[] };
    const labels = cfg.intents?.length ? cfg.intents : DEFAULT_INTENTS;
    intent = await classifyIntent(llm, text, labels).catch(() => null);
  }
  if (!intent) return;

  // Sentiment read on the opener — the same "does a human need to see this"
  // signal a topic match is, fired only when a rule asked for it.
  if (llm) await checkSentiment(db, agent, conv, llm, rules, text);

  // Intent routing — rules whose intents list names this label. Non-stealing
  // like keyword routing: only fills an unassigned thread. intent-kind rules
  // route through their alert fire instead, so their pools rotate there.
  const silent = intentMatches(rules, intent).filter((r) => r.kind !== 'intent');
  const alerting = intentMatches(rules, intent, 'intent');
  const actions = silent.map((r) => r.config as RuleConfig);
  const assignTo = actions.map((a) => a.assign_to).find(Boolean);
  const tags = actions.map((a) => a.tag).filter((t): t is string => !!t);

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

  // Topic alert — "paging you because this looks like billing" is the same
  // signal Reports → Topics tallies. Routing resolves inside the fire so a
  // group/pool target still picks a member.
  if (alerting.length) {
    await fireRuleAlert(db, agent, updated, {
      type: 'intent',
      detail: `topic: ${intent}`,
      rules: alerting,
    }).catch((err) => console.error('[intent] topic alert failed:', err));
  }
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
  const rules = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.agentId, agent.id));

  // Tone can drift too — a conversation that opened calm and turned
  // hostile mid-thread is exactly what a sentiment rule exists for.
  await checkSentiment(db, agent, conv, llm, rules, text);

  const next = await classifyIntent(llm, text, labels).catch(() => null);
  if (!next || next === conv.intent || next === 'other') return;

  // Re-fire the new intent's rule tags; assignment still only fills an
  // empty slot so a mid-conversation drift can't steal someone's queue.
  const silent = intentMatches(rules, next).filter((r) => r.kind !== 'intent');
  const alerting = intentMatches(rules, next, 'intent');
  const tags = silent
    .map((r) => (r.config as RuleConfig).tag)
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

  if (alerting.length) {
    await fireRuleAlert(db, agent, updated, {
      type: 'intent',
      detail: `topic drifted to: ${next}`,
      rules: alerting,
    }).catch((err) => console.error('[intent] topic alert failed:', err));
  }
}
