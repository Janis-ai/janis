/**
 * Client-side scenario prompt matching — port of apps/api/lib/promptMatch.ts
 * tiers 1–2 (keep them in sync): a scenario is recognized by meaning, not
 * verbatim text, so typos and light rewording still attach to the saved row.
 * The server adds tier 3 (LLM paraphrase) — clients reach it through
 * /tests/match via the useScenarioMatch hook below.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { scenarioPrompt, type ScenarioTest, type ScenarioTurn } from '../components/ScenarioRow';

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

// Context-aware matching — mirrors the server helpers in
// apps/api/lib/promptMatch.ts (keep in sync). A query's `turns` end at the
// trigger customer message; everything before it is the context.

/** Everything before the trigger (last customer turn). */
function contextOf(turns: ScenarioTurn[]): ScenarioTurn[] {
  let last = -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'customer') last = i;
  }
  return turns.slice(0, Math.max(0, last));
}

/** 1 for identical/absent contexts, 0 when one side is bare, else Jaccard
 *  over content words — reorders count, different topics don't. */
function contextScore(a: ScenarioTurn[], b: ScenarioTurn[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const na = normalizePrompt(a.map((t) => t.text).join(' '));
  const nb = normalizePrompt(b.map((t) => t.text).join(' '));
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = contentTokens(na);
  const tb = contentTokens(nb);
  return ta.size && tb.size ? jaccard(ta, tb) : 0;
}

/** Cache key — prompt alone for bare queries, prompt+context signature
 *  when the query carries a setup, so the same trigger in two flows can
 *  resolve to different rows. */
function querySig(prompt: string, turns?: ScenarioTurn[]): string {
  return `${normalizePrompt(prompt)}|${normalizePrompt(
    contextOf(turns ?? [])
      .map((t) => t.text)
      .join(' '),
  )}`;
}

/** Local match — instant. Single trigger hit attaches regardless of
 *  context (the hybrid: no per-message veto); several same-trigger
 *  scenarios get disambiguated by context word-overlap. Returns null when
 *  nothing resolves locally — the caller queues the semantic pass. */
export function findScenario(
  prompt: string | undefined,
  tests: ScenarioTest[],
  turns?: ScenarioTurn[],
): ScenarioTest | undefined {
  if (!prompt) return undefined;
  const hits = tests.filter((t) => promptsSimilar(prompt, scenarioPrompt(t)));
  if (hits.length === 1) return hits[0];
  if (hits.length < 2) return undefined;
  const ctx = contextOf(turns ?? []);
  let best: ScenarioTest | undefined;
  let bestScore = 0.3;
  let tie = false;
  for (const t of hits) {
    const s = ctx.length ? contextScore(ctx, contextOf(t.turns ?? [])) : 1;
    if (s > bestScore) {
      best = t;
      bestScore = s;
      tie = false;
    } else if (s === bestScore) tie = true;
  }
  return best && !tie ? best : undefined;
}

// Semantic results are per-agent module state — shared by every mounted
// hook instance (builder, dock fallback, inbox) and across page mounts.
// Without this, each section switch re-asked /tests/match for prompts it
// already resolved, and a paraphrase's Aim/verdict box visibly hid then
// reappeared on every handoff.
const SEMANTIC_HITS = new Map<string, Map<string, string>>(); // agentId → querySig → scenarioId | ''
const SEMANTIC_FP = new Map<string, string>(); // agentId → tests id fingerprint
const SEMANTIC_PENDING = new Map<string, Map<string, { prompt: string; turns?: ScenarioTurn[] }>>(); // agentId → sig → query
const MATCH_LISTENERS = new Set<() => void>();

function recordHits(agentId: string, batch: [string, string | null][]) {
  let m = SEMANTIC_HITS.get(agentId);
  if (!m) SEMANTIC_HITS.set(agentId, (m = new Map()));
  for (const [sig, id] of batch) m.set(sig, id ?? '');
  for (const l of MATCH_LISTENERS) l();
}

function flushSemantic(agentId: string) {
  const map = SEMANTIC_PENDING.get(agentId);
  if (!map?.size) return;
  const batch = [...map];
  map.clear();
  api<{ matches: (string | null)[] }>(`/api/agents/${agentId}/tests/match`, {
    method: 'POST',
    body: JSON.stringify({ queries: batch.map(([, q]) => q) }),
  })
    .then((r) =>
      recordHits(agentId, batch.map(([sig], i) => [sig, r.matches[i] ?? null])),
    )
    .catch(() => recordHits(agentId, batch.map(([sig]) => [sig, null]))) // endpoint failed — record misses, retry on next fp change
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

  return (prompt?: string, turns?: ScenarioTurn[]): ScenarioTest | undefined => {
    if (!prompt) return undefined;
    const local = findScenario(prompt, tests, turns);
    if (local) return local;
    const sig = querySig(prompt, turns);
    const hits = agentId ? SEMANTIC_HITS.get(agentId) : undefined;
    const id = hits?.get(sig);
    if (id) return tests.find((t) => t.id === id);
    if (agentId && !hits?.has(sig)) {
      let map = SEMANTIC_PENDING.get(agentId);
      if (!map) SEMANTIC_PENDING.set(agentId, (map = new Map()));
      if (!map.has(sig)) {
        map.set(sig, { prompt, turns });
        // Microtask so every prompt queued in this render batch rides
        // one POST instead of one request per render call.
        queueMicrotask(() => flushSemantic(agentId));
      }
    }
    return undefined;
  };
}
