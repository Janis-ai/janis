/**
 * Scenario prompt matching — a saved scenario should be recognized by
 * meaning, not verbatim text: "do you like cheese" and "are you a fan of
 * cheese" are the same check, and a typo shouldn't orphan it. Three
 * tiers, cheapest first:
 *
 *   1. normalized equality  — case/punctuation/whitespace differences
 *   2. fuzzy                — Levenshtein on the normalized string (typos)
 *                            + content-word Jaccard (reorders, light reword)
 *   3. semantic             — an LLM paraphrase check (semanticScenarioMatch
 *                            / matchPromptsSemantically), used only where a
 *                            miss is worth a model call
 *
 * The web side ports tiers 1–2 verbatim in lib/scenarioMatch.ts — keep the
 * two implementations in sync so client prediction and server dedupe agree.
 */

const STOPWORDS = new Set(
  ('a an and are as at be but by can could do does for from had has have how i if in is it its ' +
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

/** Classic Levenshtein — short customer prompts keep the O(n·m) trivial. */
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

/** True when two prompts are close enough to be the same scenario without
 *  a model call — identical after normalization, near-identical spelling
 *  (≥80% similar), or ≥60% shared content words. */
export function promptsSimilar(a: string, b: string): boolean {
  const na = normalizePrompt(a);
  const nb = normalizePrompt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Typos: edit distance vs length — "chese"/"cheese" score ~0.9.
  const dist = levenshtein(na, nb);
  if (dist / Math.max(na.length, nb.length) <= 0.2) return true;
  // Reorders / light rewording share most content words.
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size && tb.size && jaccard(ta, tb) >= 0.6) return true;
  return false;
}

// ── Tier 3: semantic (LLM) ─────────────────────────────────────────────

import { complete, type LlmSettings } from './hostedAgent.js';

const MATCH_SYSTEM =
  'You match customer messages to a list of saved scenario prompts. For each ' +
  'numbered INPUT, decide which numbered SCENARIO asks for essentially the ' +
  'same thing — the same intent, needing the same answer. Paraphrases, ' +
  'reworded questions, and typos count as the same; merely related topics do ' +
  'NOT. Reply with ONLY a JSON object mapping each input number to a scenario ' +
  'number or null, e.g. {"1": 2, "2": null}.';

/** Batched paraphrase check — returns {inputIndex → candidateIndex}. Only
 *  call for prompts the fuzzy matcher missed; caps keep the call cheap. */
export async function matchPromptsSemantically(
  llm: LlmSettings,
  inputs: string[],
  candidates: string[],
): Promise<Record<number, number | null>> {
  const ins = inputs.slice(0, 20);
  const cands = candidates.slice(0, 60);
  if (!ins.length || !cands.length) return {};
  const res = await complete(llm, MATCH_SYSTEM, [
    {
      role: 'user',
      content:
        'SCENARIOS:\n' +
        cands.map((s, i) => `${i + 1}. ${s}`).join('\n') +
        '\n\nINPUTS:\n' +
        ins.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    },
  ]);
  const m = res.text?.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[0]) as Record<string, number | null>;
    const out: Record<number, number | null> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const i = Number(k) - 1;
      const j = v == null ? null : Number(v) - 1;
      if (i >= 0 && i < ins.length && (j === null || (j >= 0 && j < cands.length))) {
        out[i] = j;
      }
    }
    return out;
  } catch {
    return {};
  }
}
