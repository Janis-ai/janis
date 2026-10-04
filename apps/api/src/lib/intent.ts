import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, alerts, conversations, messages } from '../db/schema.js';
import { bus } from './bus.js';
import { llmFor, type LlmSettings } from './llm.js';
import { fireRuleAlert } from './ruleAlerts.js';
import { intentMatches, ruleEnabled, type RuleConfig } from './rules.js';
import { systemNote } from './systemNote.js';

import { DEFAULT_INTENTS } from '@janis/shared';

/** Shared chat-completion call for the tiny classifiers — temperature 0,
 *  8 tokens out, 10s cap, message truncated to 2k chars. Returns the raw
 *  trimmed/lowercased answer; each caller validates against its own label
 *  set. */
async function llmClassify(
  llm: LlmSettings,
  system: string,
  text: string,
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
        { role: 'system', content: system },
        { role: 'user', content: text.slice(0, 2000) },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (body.choices?.[0]?.message?.content ?? '').trim().toLowerCase() || null;
}

/** One cheap chat completion — classify the opener into a taxonomy label. */
export async function classifyIntent(
  llm: LlmSettings,
  text: string,
  labels: string[],
): Promise<string | null> {
  const raw = await llmClassify(
    llm,
    'Classify the customer message into exactly one label from this list: ' +
      labels.join(', ') +
      '. Reply with the label only — no punctuation, no explanation.',
    text,
  );
  if (!raw) return null;
  // Exact match first, then a contains-match for labels the model decorated.
  const exact = labels.find((l) => l.toLowerCase() === raw);
  if (exact) return exact;
  const loose = labels.find((l) => raw.includes(l.toLowerCase()));
  return loose ?? 'other';
}

/** One cheap chat completion — read the customer's tone. Runs every inbound
 *  turn when the agent has an LLM; sentiment rules gate only the alert. */
export async function classifySentiment(
  llm: LlmSettings,
  text: string,
): Promise<'positive' | 'neutral' | 'negative' | null> {
  const raw = await llmClassify(
    llm,
    'Read the customer message and classify their sentiment as exactly one of: positive, neutral, negative. ' +
      'Negative means frustrated, angry, or upset — not merely asking for help. ' +
      'Reply with the label only — no punctuation, no explanation.',
    text,
  );
  if (raw === 'positive' || raw === 'neutral' || raw === 'negative') return raw;
  return null;
}

/** Sentiment rules enabled on this agent — they gate the ALERT, not the
 *  read: every inbound turn is scored and persisted so the Details card can
 *  show the thread's current mood regardless of rule config. */
function sentimentRules(rules: (typeof alertRules.$inferSelect)[]) {
  return rules.filter((r) => r.kind === 'sentiment' && ruleEnabled(r));
}

/** Classify tone and persist it on the conversation when it changed — one
 *  field tracks the thread's latest mood; a bus event refreshes open detail
 *  pages so the badge updates live. */
async function scoreSentiment(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  llm: LlmSettings,
  text: string,
): Promise<'positive' | 'neutral' | 'negative' | null> {
  const s = await classifySentiment(llm, text).catch(() => null);
  if (!s || s === conv.sentiment) return s;
  await db
    .update(conversations)
    .set({ sentiment: s })
    .where(eq(conversations.id, conv.id));
  conv.sentiment = s; // keep the in-memory row honest for later checks
  bus.publish(agent.workspaceId, {
    type: 'conversation',
    data: { id: conv.id, state: conv.state },
  });
  return s;
}

/** Transcript trace for a negative read with no sentiment rule — the score
 *  updates either way, but a rule-less agent would otherwise leave no record
 *  of the flip. Transition-only: a thread that stays negative doesn't re-note
 *  (when a rule fires, fireRuleAlert's own note covers the trace). */
async function noteSentimentFlip(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  prev: string | null,
): Promise<void> {
  if (prev === 'negative') return;
  await systemNote(
    db,
    agent.workspaceId,
    conv.id,
    'Negative sentiment — customer sentiment classified negative',
    'sentiment',
  );
}

/** Score tone and fire sentiment rules on a negative read — shared by the
 *  opener classification, the drift re-check, and the per-inbound check. */
async function checkSentiment(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  llm: LlmSettings,
  rules: (typeof alertRules.$inferSelect)[],
  text: string,
): Promise<void> {
  const prev = conv.sentiment;
  const s = await scoreSentiment(db, agent, conv, llm, text);
  if (s !== 'negative') return;
  const fired = sentimentRules(rules);
  if (!fired.length) {
    await noteSentimentFlip(db, agent, conv, prev);
    return;
  }
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
  // The LLM is needed for sentiment even when the intent came in BYO or no
  // rules exist — the opener's tone seeds the Details-card score.
  let llm: LlmSettings | null = null;
  try {
    llm = await llmFor(db, agent);
  } catch {
    llm = null; // unpriced/no LLM — classification silently skipped
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

/** Per-inbound sentiment — scores every customer turn so the conversation's
 *  mood stays current in the Details card, and fires sentiment rules on a
 *  negative read. Runs even without rules (the score is what the UI shows);
 *  the rules query is skipped until a negative read needs it. Repeat
 *  negatives dedupe on the open alert, so an angry thread pages once. */
export async function checkInboundSentiment(
  db: Db,
  agent: typeof agents.$inferSelect,
  conv: typeof conversations.$inferSelect,
  text: string,
  /** Callers that already loaded the agent's rules pass them to skip the
   *  query — ingest fetches them once per batch anyway. */
  knownRules?: (typeof alertRules.$inferSelect)[],
): Promise<void> {
  let llm: LlmSettings;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return;
  }
  const prev = conv.sentiment;
  const s = await scoreSentiment(db, agent, conv, llm, text);
  if (s !== 'negative') return;
  const rules =
    knownRules ??
    (await db.select().from(alertRules).where(eq(alertRules.agentId, agent.id)));
  const fired = sentimentRules(rules);
  if (!fired.length) {
    await noteSentimentFlip(db, agent, conv, prev);
    return;
  }
  await fireRuleAlert(db, agent, conv, {
    type: 'sentiment',
    detail: 'customer sentiment classified negative',
    rules: fired,
  }).catch((err) => console.error('[intent] sentiment alert failed:', err));
}

/** Enabling a sentiment rule surfaces threads ALREADY scored negative, not
 *  just the next angry message — the score outlives the rule. Each conv goes
 *  through the normal fire path (dedupe, routing, notes, dispatch); convs
 *  already carrying an open sentiment alert are skipped so a re-enable
 *  doesn't re-note. Capped at the 25 most recent open threads — a review
 *  pass, not a notification storm. */
export async function backfillSentimentAlerts(
  db: Db,
  agent: typeof agents.$inferSelect,
  rule: typeof alertRules.$inferSelect,
): Promise<void> {
  const convs = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.sentiment, 'negative'),
        ne(conversations.state, 'archived'),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(25);
  if (!convs.length) return;
  const alerted = new Set(
    (
      await db
        .select({ conversationId: alerts.conversationId })
        .from(alerts)
        .where(
          and(
            inArray(alerts.conversationId, convs.map((x) => x.id)),
            eq(alerts.type, 'sentiment'),
            eq(alerts.status, 'open'),
          ),
        )
    ).map((a) => a.conversationId),
  );
  for (const conv of convs) {
    if (alerted.has(conv.id)) continue;
    await fireRuleAlert(db, agent, conv, {
      type: 'sentiment',
      detail: 'customer sentiment classified negative',
      rules: [rule],
    }).catch((err) => console.error('[intent] sentiment backfill failed:', err));
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

  // No sentiment check here — checkInboundSentiment scores every turn as it
  // arrives, so a window-level re-read would just double-classify (and
  // double-note) the same mood.

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
