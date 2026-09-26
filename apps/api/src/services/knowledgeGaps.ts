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
  /** Questions with this intent the agent has since answered on its own. */
  handled: string[];
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

/** Questions that are just "let me talk to a human" — the handoff worked as
 * designed, there's no knowledge to add. Checked against normalized words so
 * "support hours" (a real gap) still counts while "human please" doesn't. */
const ESCALATION_ONLY = new Set(
  'human agent operator person someone somebody anyone anybody real live representative rep support staff team member manager escalate please help speak talk talkto'.split(
    ' ',
  ),
);
function isEscalationRequest(words: Set<string>): boolean {
  return words.size > 0 && [...words].every((w) => ESCALATION_ONLY.has(w));
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

  // Handled occurrences: an inbound question the agent answered itself (the
  // next message is a clean 'out' — no alert flags). A cluster is resolved
  // when a same-intent question was handled AFTER its last escalation.
  const recent = await db
    .select({
      convId: messages.conversationId,
      direction: messages.direction,
      text: messages.text,
      flags: messages.flags,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.agentId, agentId), gt(messages.createdAt, cutoff)))
    .orderBy(desc(messages.createdAt))
    .limit(4000);
  recent.reverse(); // chronological

  const byConvRecent = new Map<string, typeof recent>();
  for (const m of recent) {
    const list = byConvRecent.get(m.convId) ?? [];
    list.push(m);
    byConvRecent.set(m.convId, list);
  }
  interface Handled {
    question: string;
    words: Set<string>;
    at: Date;
  }
  const handled: Handled[] = [];
  const handledSeen = new Set<string>();
  for (const msgs of byConvRecent.values()) {
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      const next = msgs[i + 1];
      if (m.direction !== 'in' || !m.text || next.direction !== 'out') continue;
      const f = next.flags as
        | { failure?: boolean; help_requested?: boolean; custom_alert?: boolean; handoff_offer?: boolean }
        | null;
      if (f?.failure || f?.help_requested || f?.custom_alert || f?.handoff_offer) continue;
      const words = normalize(m.text);
      if (!words.size || isEscalationRequest(words)) continue;
      const dk = m.text.toLowerCase().slice(0, 60);
      if (handledSeen.has(dk)) continue;
      handledSeen.add(dk);
      handled.push({ question: m.text, words, at: m.createdAt });
    }
  }

  // Greedy single-pass clustering by Jaccard ≥ 0.5 on normalized word sets
  interface Acc extends Event {
    words: Set<string>;
  }
  const clusters: { words: Set<string>; members: Acc[] }[] = [];
  for (const e of events) {
    const words = normalize(e.question);
    if (!words.size || isEscalationRequest(words)) continue;
    const hit = clusters.find((cl) => jaccard(cl.words, words) >= 0.5);
    if (hit) {
      hit.members.push({ ...e, words });
      for (const w of words) hit.words.add(w); // union keeps clusters merging
    } else {
      clusters.push({ words, members: [{ ...e, words }] });
    }
  }

  const agentRow = (
    await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  )[0];
  const knowledge =
    ((agentRow?.config ?? {}) as { knowledge?: string[] }).knowledge ?? [];
  const knowledgeSets = knowledge.map(normalize);

  // Intent-level merge + resolution detection via the agent's LLM. One call:
  // "merge" groups cluster numbers that ask the same thing in different words;
  // "resolved" maps a cluster number to handled-question numbers of the same
  // intent — the code then checks the handled occurrence is NEWER than the
  // last escalation before dropping the cluster.
  if (agentRow && clusters.length) {
    const lastEsc = clusters.map(
      (cl) => Math.max(...cl.members.map((m) => m.at.getTime())),
    );
    const aList = clusters.map(
      (cl, i) => `${i + 1}. ${cl.members[0].question}`,
    );
    // newest 60 handled questions form list B — resolvedMap indexes into this
    const handledB = handled.slice(-60);
    const bList = handledB.map((h, i) => `${i + 1}. ${h.question}`);
    const prompt = [
      'A — recurring customer questions that escalated to a human:',
      ...aList,
      '',
      'B — recent customer questions the AI answered WITHOUT a human:',
      ...(bList.length ? bList : ['(none)']),
    ].join('\n');
    const text =
      clusters.length > 1 || handled.length
        ? await llmChat(
            db,
            agentRow,
            'You group customer support questions by intent. Given list A ' +
              '(questions that needed a human) and list B (questions the AI ' +
              'answered alone), reply with JSON only: {"merge":[[1,4]],"resolved"' +
              ':{"1":[2]}} — merge groups A-numbers expressing the same request; ' +
              'resolved maps an A-number to B-numbers asking the same thing.',
            prompt,
            400,
          )
        : null;
    let merge: number[][] = [];
    let resolvedMap: Record<string, number[]> = {};
    if (text) {
      try {
        const parsed = JSON.parse(
          text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
        ) as { merge?: number[][]; resolved?: Record<string, number[]> };
        merge = (parsed.merge ?? []).filter((g) => Array.isArray(g));
        resolvedMap = parsed.resolved ?? {};
      } catch {
        /* fall through to lexical-only */
      }
    } else {
      // No LLM: conservative lexical merge — a handled question resolves a
      // cluster only on strong overlap, and only when it's newer than the
      // cluster's last escalation.
      const covered = new Set<number>();
      clusters.forEach((cl, i) => {
        const hit = handled.some(
          (h) =>
            h.at.getTime() > lastEsc[i] &&
            cl.members.some((m) => {
              const j = jaccard(h.words, m.words);
              const subset =
                Math.min(h.words.size, m.words.size) >= 2 &&
                [...h.words].every((w) => m.words.has(w));
              return j >= 0.5 || subset;
            }),
        );
        if (hit) covered.add(i);
      });
      for (const i of covered) resolvedMap[String(i + 1)] = [-1];
    }

    // Apply intent merges (union-find over cluster indices).
    const parent = clusters.map((_, i) => i);
    const find = (x: number): number =>
      parent[x] === x ? x : (parent[x] = find(parent[x]));
    for (const g of merge)
      for (const idx of g.slice(1))
        if (clusters[g[0] - 1] && clusters[idx - 1]) {
          parent[find(idx - 1)] = find(g[0] - 1);
        }
    const merged = new Map<number, { words: Set<string>; members: Acc[] }>();
    clusters.forEach((cl, i) => {
      const root = find(i);
      const cur = merged.get(root) ?? { words: new Set(), members: [] };
      for (const m of cl.members) cur.members.push(m);
      for (const w of cl.words) cur.words.add(w);
      merged.set(root, cur);
    });

    // Which merged clusters are resolved? A resolvedMap entry marks the
    // cluster resolved only if some mapped (or lexically-matched) handled
    // question is newer than the MERGED cluster's last escalation — merging
    // can pull in a newer escalation than the flagged cluster's own.
    const mergedLastEsc = new Map<number, number>();
    for (const [root, cl] of merged)
      mergedLastEsc.set(root, Math.max(...cl.members.map((m) => m.at.getTime())));
    const resolvedRoots = new Set<number>();
    for (const [aStr, bIdxs] of Object.entries(resolvedMap)) {
      const aIdx = Number(aStr) - 1;
      if (!clusters[aIdx]) continue;
      const root = find(aIdx);
      const last = mergedLastEsc.get(root) ?? 0;
      const ok = bIdxs.includes(-1) // lexical fallback already date-checked
        ? true
        : bIdxs.some((b) => handledB[b - 1] && handledB[b - 1].at.getTime() > last);
      if (ok) resolvedRoots.add(root);
    }
    for (const root of resolvedRoots) merged.delete(root);

    // Attach same-intent handled questions to surviving clusters for display.
    const finalClusters = [...merged.values()].map((cl) => ({
      members: cl.members.sort((a, b) => b.at.getTime() - a.at.getTime()),
      handledQs: handled
        .filter((h) => cl.members.some((m) => jaccard(h.words, m.words) >= 0.5))
        .map((h) => h.question)
        .slice(0, 3),
    }));

    return finalClusters
      .filter((cl) => cl.members.length >= minCluster)
      .map((cl) => {
        const members = cl.members;
        return {
          // key on the OLDEST member's question — stable across reclustering so
          // dismissals/recheck results survive new occurrences
          key: members.at(-1)!.question.toLowerCase().slice(0, 60),
          count: members.length,
          questions: [...new Set(members.map((m) => m.question))].slice(0, 5),
          resolutions: [
            ...new Set(members.map((m) => m.resolution).filter(Boolean)),
          ].slice(0, 3),
          conversation_ids: [...new Set(members.map((m) => m.convId))],
          last_seen: members[0].at.toISOString(),
          // "added" = a knowledge entry already covers one of the cluster's
          // questions — entries approved via the draft flow embed the question.
          added: knowledgeSets.some((ks) =>
            members.some((m) => jaccard(ks, m.words) >= 0.35),
          ),
          handled: cl.handledQs,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }

  return [];
}

/** Cached detection result stored on agent.config.gaps_cache — detection is
 * recomputed only when stale or explicitly refreshed, so a page shows a stable
 * gap set between refreshes instead of re-rolling the LLM on every load. */
export interface GapsCache {
  at: string;
  gaps: GapCluster[];
}

export const GAPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function readGapsCache(config: unknown): GapsCache | null {
  const c = (config ?? {}) as { gaps_cache?: GapsCache };
  return c.gaps_cache?.gaps ? c.gaps_cache : null;
}

export function gapsCacheFresh(cache: GapsCache | null): boolean {
  return !!cache && Date.now() - new Date(cache.at).getTime() < GAPS_CACHE_TTL_MS;
}

/** Re-evaluate `added` on cached clusters after a knowledge entry is approved —
 * the gap set stays stable; only its resolved-flags move. */
export function markGapsAdded(gaps: GapCluster[], knowledge: string[]): GapCluster[] {
  const knowledgeSets = knowledge.map(normalize);
  return gaps.map((g) => ({
    ...g,
    added: knowledgeSets.some((ks) =>
      g.questions.some((q) => jaccard(ks, normalize(q)) >= 0.35),
    ),
  }));
}

export interface LearnNote {
  key: string;
  text: string;
  conversation_id: string;
  last_seen: string;
  added: boolean;
}

/** "LEARN:" self-reports the agent embeds in its replies — stored on the
 * out-message payload. Deduped by text, newest first; "added" when a similar
 * knowledge entry already exists so resolved notes stop surfacing. */
export async function listLearnNotes(
  db: Db,
  agentId: string,
  opts: { days?: number } = {},
): Promise<LearnNote[]> {
  const cutoff = new Date(Date.now() - (opts.days ?? 30) * 86_400_000);
  const rows = await db
    .select({
      convId: messages.conversationId,
      payload: messages.payload,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.agentId, agentId),
        eq(messages.direction, 'out'),
        gt(messages.createdAt, cutoff),
        sql`jsonb_typeof(${messages.payload}->'learn') = 'array'`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(300);

  const knowledge = (((await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1))[0]?.config ?? {}) as { knowledge?: string[] }).knowledge ?? [];
  const knowledgeSets = knowledge.map(normalize);

  const seen = new Map<string, LearnNote>();
  for (const r of rows) {
    const learn = (r.payload as { learn?: unknown })?.learn;
    if (!Array.isArray(learn)) continue;
    for (const item of learn) {
      const text = String(item).trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue; // newest first — keep first hit
      seen.set(key, {
        key,
        text,
        conversation_id: r.convId,
        last_seen: r.createdAt.toISOString(),
        added: knowledgeSets.some((ks) => jaccard(ks, normalize(text)) >= 0.35),
      });
    }
  }
  return [...seen.values()].slice(0, 20);
}

const DRAFT_SYSTEM =
  'You write knowledge base entries for a customer support AI. Given recurring ' +
  'customer questions and how human agents answered them, write ONE concise ' +
  'knowledge entry the agent can use to answer next time. Format: the question ' +
  'or topic, then a 1-3 sentence answer in a helpful support tone. No preamble.';

/** One-shot chat call for knowledge tooling — records usage, returns null on
 * any failure so callers can fall back. */
async function llmChat(
  db: Db,
  agent: typeof agents.$inferSelect,
  system: string,
  user: string,
  maxTokens = 220,
): Promise<string | null> {
  const llm = await llmFor(db, agent);
  if (!llm.apiKey) return null;
  try {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
        ...(llm.headers ?? {}),
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: maxTokens,
        temperature: 0, // deterministic merges — identical input, identical clusters
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
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
      model: llm.model,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      byok: llm.byok,
    }).catch(() => {});
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

const RECHECK_SYSTEM =
  'You audit a support AI\'s knowledge base. Given its knowledge entries and a ' +
  'numbered list of customer questions that previously needed a human, reply ' +
  'with JSON only: {"covered":[1,3]} — the numbers of questions the knowledge ' +
  'now covers well enough to answer confidently.';

/** Which clusters' questions are now covered by the knowledge base — used to
 * auto-dismiss stale gaps after the operator trains the agent. */
export async function recheckGaps(
  db: Db,
  agent: typeof agents.$inferSelect,
  clusters: GapCluster[],
): Promise<string[]> {
  const knowledge = ((agent.config ?? {}) as { knowledge?: string[] }).knowledge ?? [];
  if (!clusters.length || !knowledge.length) return [];
  const user = [
    'Knowledge entries:',
    ...knowledge.slice(0, 60).map((k) => `- ${k}`),
    '',
    'Recurring questions:',
    ...clusters.map((cl, i) => `${i + 1}. ${cl.questions[0]}`),
  ].join('\n');
  const text = await llmChat(db, agent, RECHECK_SYSTEM, user, 300);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      covered?: number[];
    };
    return (parsed.covered ?? [])
      .map((i) => clusters[i - 1]?.key)
      .filter((k): k is string => !!k);
  } catch {
    return [];
  }
}

/** Draft a knowledge entry for a cluster — LLM when configured, else a template. */
export async function draftKnowledgeEntry(
  db: Db,
  agent: typeof agents.$inferSelect,
  questions: string[],
  resolutions: string[],
): Promise<string> {
  const user = [
    'Recurring customer questions:',
    ...questions.map((q) => `- ${q}`),
    resolutions.length ? '\nHow human agents resolved them:' : '',
    ...resolutions.map((r) => `- ${r}`),
  ]
    .filter(Boolean)
    .join('\n');
  const text = await llmChat(db, agent, DRAFT_SYSTEM, user);
  if (text) return text;
  // No LLM / failure — template the operator edits before approving
  const q = questions[0] ?? 'Recurring question';
  const a = resolutions[0];
  return a ? `Q: ${q}\nA: ${a}` : `Q: ${q}\nA: `;
}
