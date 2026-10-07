/**
 * Client-side scenario prompt matching — port of apps/api/lib/promptMatch.ts
 * tiers 1–2 (keep them in sync): a scenario is recognized by meaning, not
 * verbatim text, so typos and light rewording still attach to the saved row.
 * The server adds tier 3 (LLM paraphrase) — clients reach it through
 * /tests/match via the useScenarioMatch hook below.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { scenarioPrompt, type ScenarioTest } from '../components/ScenarioRow';

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could do does for from had has have how i if in is it its ' +
    'me my of on or please should so that the their them they this to was we what when where which ' +
    'who will with would you your'
  ).split(' '),
);

/** Lowercase, accent-folded, punctuation-free, whitespace-collapsed. */
export function normalizePrompt(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentTokens(s: string): Set<string> {
  return new Set(
    normalizePrompt(s)
      .split(' ')
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

/** Same predicate the server runs — near-verbatim, typo-tolerant, and
 *  reorder-tolerant without a model call. */
export function promptsSimilar(a: string, b: string): boolean {
  const na = normalizePrompt(a);
  const nb = normalizePrompt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const dist = levenshtein(na, nb);
  if (dist / Math.max(na.length, nb.length) <= 0.2) return true;
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  return ta.size > 0 && tb.size > 0 && jaccard(ta, tb) >= 0.6;
}

/** Local-only match — instant, covers typos and light rewording. */
export function findScenario(
  prompt: string | undefined,
  tests: ScenarioTest[],
): ScenarioTest | undefined {
  if (!prompt) return undefined;
  return tests.find((t) => promptsSimilar(prompt, scenarioPrompt(t)));
}

// Semantic results are per-agent module state — shared by every mounted
// hook instance (builder, dock fallback, inbox) and across page mounts.
// Without this, each section switch re-asked /tests/match for prompts it
// already resolved, and a paraphrase's Aim/verdict box visibly hid then
// reappeared on every handoff.
const SEMANTIC_HITS = new Map<string, Map<string, string>>(); // agentId → normPrompt → scenarioId | ''
const SEMANTIC_FP = new Map<string, string>(); // agentId → tests id fingerprint
const SEMANTIC_PENDING = new Map<string, Set<string>>(); // agentId → normPrompts awaiting a batch
const MATCH_LISTENERS = new Set<() => void>();

function recordHits(agentId: string, batch: string[], matches: Record<string, string>) {
  let m = SEMANTIC_HITS.get(agentId);
  if (!m) SEMANTIC_HITS.set(agentId, (m = new Map()));
  for (const p of batch) m.set(p, matches[p] ?? '');
  for (const l of MATCH_LISTENERS) l();
}

function flushSemantic(agentId: string) {
  const set = SEMANTIC_PENDING.get(agentId);
  if (!set?.size) return;
  const batch = [...set];
  set.clear();
  api<{ matches: Record<string, string> }>(`/api/agents/${agentId}/tests/match`, {
    method: 'POST',
    body: JSON.stringify({ prompts: batch }),
  })
    .then((r) => recordHits(agentId, batch, r.matches))
    .catch(() => recordHits(agentId, batch, {})) // endpoint failed — record misses, retry on next fp change
    .finally(() => flushSemantic(agentId)); // prompts queued mid-flight chain one more batch
}

/**
 * Full matcher: local fuzzy hit first; on a miss the prompt is queued for
 * the server's semantic pass (/tests/match) and the shared result lands on
 * the next render — the verdict box simply appears a beat later, once.
 * Misses are cached as '' so a prompt that matched nothing doesn't
 * re-ask; the cache clears only when the agent's scenario set changes.
 */
export function useScenarioMatch(agentId: string | undefined, tests: ScenarioTest[]) {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((v) => v + 1);
    MATCH_LISTENERS.add(fn);
    return () => {
      MATCH_LISTENERS.delete(fn);
    };
  }, []);

  // Reset when the scenario SET changes — callers pass `data?.tests ?? []`,
  // which is a fresh array every render while loading, so depending on the
  // array itself would reset on every render. The id fingerprint is stable
  // across renders and refetches of identical content.
  const fingerprint = tests.map((t) => t.id).join(' ');
  useEffect(() => {
    if (!agentId || SEMANTIC_FP.get(agentId) === fingerprint) return;
    SEMANTIC_FP.set(agentId, fingerprint);
    SEMANTIC_HITS.delete(agentId);
    SEMANTIC_PENDING.delete(agentId);
  }, [agentId, fingerprint]);

  return (prompt?: string): ScenarioTest | undefined => {
    if (!prompt) return undefined;
    const local = findScenario(prompt, tests);
    if (local) return local;
    const n = normalizePrompt(prompt);
    const hits = agentId ? SEMANTIC_HITS.get(agentId) : undefined;
    const id = hits?.get(n);
    if (id) return tests.find((t) => t.id === id);
    if (agentId && !hits?.has(n)) {
      let set = SEMANTIC_PENDING.get(agentId);
      if (!set) SEMANTIC_PENDING.set(agentId, (set = new Set()));
      if (!set.has(n)) {
        set.add(n);
        // Microtask so every prompt queued in this render batch rides
        // one POST instead of one request per render call.
        queueMicrotask(() => flushSemantic(agentId));
      }
    }
    return undefined;
  };
}
