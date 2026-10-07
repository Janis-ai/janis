/**
 * Client-side scenario prompt matching — port of apps/api/lib/promptMatch.ts
 * tiers 1–2 (keep them in sync): a scenario is recognized by meaning, not
 * verbatim text, so typos and light rewording still attach to the saved row.
 * The server adds tier 3 (LLM paraphrase) — clients reach it through
 * /tests/match via the useScenarioMatch hook below.
 */
import { useEffect, useRef, useState } from 'react';
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

/**
 * Full matcher: local fuzzy hit first; on a miss the prompt is queued for
 * the server's semantic pass (/tests/match) and the result lands in the
 * map on the next render — the verdict box simply appears a beat later.
 * Misses are cached as '' so a prompt that matched nothing doesn't
 * re-ask every render; the cache clears when the tests list changes.
 */
export function useScenarioMatch(agentId: string | undefined, tests: ScenarioTest[]) {
  const [serverHits, setServerHits] = useState<ReadonlyMap<string, string>>(new Map());
  const pending = useRef(new Set<string>());
  const flushing = useRef(false);

  // Reset when the scenario SET changes — callers pass `data?.tests ?? []`,
  // which is a fresh array every render while loading, so depending on the
  // array itself would reset (and re-render) forever. The id fingerprint is
  // stable across renders and refetches of identical content.
  const fingerprint = tests.map((t) => t.id).join(' ');
  useEffect(() => {
    pending.current.clear();
    setServerHits((m) => (m.size ? new Map() : m));
  }, [fingerprint]);

  useEffect(() => {
    if (!agentId || flushing.current || !pending.current.size) return;
    flushing.current = true;
    const batch = [...pending.current];
    pending.current.clear();
    api<{ matches: Record<string, string> }>(`/api/agents/${agentId}/tests/match`, {
      method: 'POST',
      body: JSON.stringify({ prompts: batch }),
    })
      .then((r) => {
        setServerHits((m) => {
          const next = new Map(m);
          for (const p of batch) next.set(normalizePrompt(p), r.matches[p] ?? '');
          return next;
        });
      })
      .catch(() => {
        // Endpoint failed — record misses rather than re-asking every
        // render; the next tests-list change clears them for a retry.
        setServerHits((m) => {
          const next = new Map(m);
          for (const p of batch) next.set(normalizePrompt(p), '');
          return next;
        });
      })
      .finally(() => {
        flushing.current = false;
      });
  });

  return (prompt?: string): ScenarioTest | undefined => {
    if (!prompt) return undefined;
    const local = findScenario(prompt, tests);
    if (local) return local;
    const n = normalizePrompt(prompt);
    const id = serverHits.get(n);
    if (id) return tests.find((t) => t.id === id);
    if (agentId && !serverHits.has(n) && !pending.current.has(n)) {
      pending.current.add(n);
    }
    return undefined;
  };
}
