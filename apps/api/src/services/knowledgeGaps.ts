import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages } from '../db/schema.js';
import { llmFor } from '../lib/hostedAgent.js';
import { recordLlmUsage } from '../lib/usage.js';

/**
 * Knowledge-gap detection: cluster conversations where the agent asked for a
 * human (help_requested / failure flags), group them by the customer question
 * that triggered the handoff, and surface clusters of 2+ as gaps the operator
 * can resolve by adding a knowledge entry. Detection is on-demand over a
 * rolling window — no separate table; "resolved" is inferred when a similar
 * entry already exists in agent.config.knowledge.
 */

export interface GapCluster {
  key: string;
  count: number;
  questions: string[];
  resolutions: string[];
  conversation_ids: string[];
  last_seen: string;
  added: boolean;
}

const STOPWORDS = new Set(
  'the a an and or but if then else for on in at to of is are was were be been it its this that these those i you we they he she do does did can could will would should may might must not no yes my your our their me him her us them what when where who why how'.split(
    ' ',
  ),
);

function normalize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      // light stemming: refunds→refund, hours→hour (plurals only)
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Pull the flagged message + the customer question + first human answer per flag. */
export async function detectKnowledgeGaps(
  db: Db,
  agentId: string,
  opts: { days?: number; minCluster?: number } = {},
): Promise<GapCluster[]> {
  const days = opts.days ?? 30;
  const minCluster = opts.minCluster ?? 2;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const flagged = await db
    .select({
      convId: messages.conversationId,
      text: messages.text,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.agentId, agentId),
        gt(messages.createdAt, cutoff),
        sql`(messages.flags->>'help_requested')::boolean = true`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(500);
  if (!flagged.length) return [];

  const convIds = [...new Set(flagged.map((f) => f.convId))];
  const window = await db
    .select({
      convId: messages.conversationId,
      direction: messages.direction,
      text: messages.text,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, convIds),
        gt(messages.createdAt, new Date(cutoff.getTime() - 7 * 86_400_000)),
      ),
    )
    .orderBy(messages.createdAt);

  const byConv = new Map<string, typeof window>();
  for (const m of window) {
    const list = byConv.get(m.convId) ?? [];
    list.push(m);
    byConv.set(m.convId, list);
  }

  interface Event {
    question: string;
    resolution: string;
    convId: string;
    at: Date;
  }
  const events: Event[] = [];
  for (const f of flagged) {
    const hist = byConv.get(f.convId) ?? [];
    // the question: last inbound message at/before the flag
    const question = [...hist]
      .reverse()
      .find((m) => m.direction === 'in' && m.createdAt <= f.createdAt && m.text)?.text;
    // the resolution: first human reply after the flag
    const resolution = hist.find(
      (m) => m.direction === 'human' && m.createdAt > f.createdAt && m.text,
    )?.text;
    if (question) {
      events.push({
        question,
        resolution: resolution ?? '',
        convId: f.convId,
        at: f.createdAt,
      });
    }
  }

  // Greedy single-pass clustering by Jaccard ≥ 0.5 on normalized word sets
  interface Acc extends Event {
    words: Set<string>;
  }
  const clusters: { words: Set<string>; members: Acc[] }[] = [];
  for (const e of events) {
    const words = normalize(e.question);
    if (!words.size) continue;
    const hit = clusters.find((cl) => jaccard(cl.words, words) >= 0.5);
    if (hit) {
      hit.members.push({ ...e, words });
      for (const w of words) hit.words.add(w); // union keeps clusters merging
    } else {
      clusters.push({ words, members: [{ ...e, words }] });
    }
  }

  const knowledge = (((await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0]?.config ?? {}) as { knowledge?: string[] }).knowledge ?? [];
  const knowledgeSets = knowledge.map(normalize);

  return clusters
    .filter((cl) => cl.members.length >= minCluster)
    .map((cl) => {
      const members = cl.members.sort((a, b) => b.at.getTime() - a.at.getTime());
      return {
        key: members[0].question.toLowerCase().slice(0, 60),
        count: members.length,
        questions: [...new Set(members.map((m) => m.question))].slice(0, 5),
        resolutions: [...new Set(members.map((m) => m.resolution).filter(Boolean))].slice(0, 3),
        conversation_ids: [...new Set(members.map((m) => m.convId))],
        last_seen: members[0].at.toISOString(),
        // "added" = a knowledge entry already covers one of the cluster's
        // questions — entries approved via the draft flow embed the question.
        added: knowledgeSets.some((ks) =>
          cl.members.some((m) => jaccard(ks, m.words) >= 0.35),
        ),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

const DRAFT_SYSTEM =
  'You write knowledge base entries for a customer support AI. Given recurring ' +
  'customer questions and how human agents answered them, write ONE concise ' +
  'knowledge entry the agent can use to answer next time. Format: the question ' +
  'or topic, then a 1-3 sentence answer in a helpful support tone. No preamble.';

/** Draft a knowledge entry for a cluster — LLM when configured, else a template. */
export async function draftKnowledgeEntry(
  db: Db,
  agent: typeof agents.$inferSelect,
  questions: string[],
  resolutions: string[],
): Promise<string> {
  const llm = llmFor(agent);
  if (llm.apiKey) {
    const user = [
      'Recurring customer questions:',
      ...questions.map((q) => `- ${q}`),
      resolutions.length ? '\nHow human agents resolved them:' : '',
      ...resolutions.map((r) => `- ${r}`),
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const res = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 220,
          messages: [
            { role: 'system', content: DRAFT_SYSTEM },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        await recordLlmUsage(db, {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          model: llm.model,
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        }).catch(() => {});
        const text = json.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {
      // fall through to the template draft
    }
  }
  // No LLM / failure — template the operator edits before approving
  const q = questions[0] ?? 'Recurring question';
  const a = resolutions[0];
  return a ? `Q: ${q}\nA: ${a}` : `Q: ${q}\nA: `;
}
