import { env } from '../env.js';
import { MODEL_CATALOG, isRateVariant } from '@janis/shared';

// USD per 1M tokens — what WE pay providers (cost basis, margin added on top).
// Derived from the shared MODEL_CATALOG (verified prices only); extend or
// override via LLM_PRICES env JSON: {"my-model":{"input":0.5,"output":1.5}}.
// Prefix-matched in insertion order, longest id first — 'gemini-3.5-flash-lite'
// must beat 'gemini-3.5-flash', 'claude-opus-5-5' must beat 'claude-opus-5'.
const RATE_CARD: Record<string, { input: number; output: number }> = {
  ...Object.fromEntries(
    [...MODEL_CATALOG]
      .filter((m) => m.price)
      .sort((a, b) => b.id.length - a.id.length)
      // billing only needs input/output — `cached` is for UI breakdowns
      .map((m) => [m.id, { input: m.price!.input, output: m.price!.output }]),
  ),
  'o4-mini': { input: 1.1, output: 4.4 },
  // self-hosted (Ollama/vLLM/Groq unknown) — assume cheap
  default: { input: 0.5, output: 1.5 },
};

/** The full card + margin, for UI rate display. */
export function allRates() {
  return { rates: RATE_CARD, margin: billingConfig.margin };
}

/** Resolved per-1M cost basis, or undefined when the model has no verified
 *  price — metered billing must refuse those rather than guess a rate. */
export function pricedRateFor(model: string | null | undefined) {
  if (!model) return undefined;
  const custom = env.llmPrices as Record<string, { input: number; output: number }> | undefined;
  if (custom?.[model]) return custom[model];
  // Normalize transport ids to catalog ids: Gemini's /models listing adds
  // 'models/', OpenRouter compounds are 'vendor/model' — both bill at the
  // catalog model's rate.
  const bare = model.replace(/^models\//, '');
  const last = bare.slice(bare.lastIndexOf('/') + 1);
  for (const id of bare === last ? [bare] : [bare, last]) {
    if (custom?.[id]) return custom[id];
    // relabel variants (dates, -latest, -preview) hit their family rate —
    // version bumps/tiers ('kimi-k2.6', '-pro') do NOT inherit: they're a
    // different SKU, billed at their own verified rate or refused
    const key = Object.keys(RATE_CARD).find((k) => k !== 'default' && isRateVariant(id, k));
    if (key) return RATE_CARD[key];
  }
  return undefined;
}

/** Resolve a model to its per-1M cost basis (prefix match → default). */
export function rateFor(model: string | null | undefined) {
  return pricedRateFor(model) ?? RATE_CARD.default;
}

/** Cost in USD-millionths for one completion. */
export function llmCostMicros(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const r = rateFor(model);
  return Math.round((promptTokens * r.input + completionTokens * r.output) / 1_000_000 * 1e6);
}

export function currentPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 7); // 'YYYY-MM'
}

/** Fixed-cost config — plan base price lives in plans.ts. */
export const billingConfig = {
  // margin applied on top of pass-through LLM cost
  margin: env.billingMargin,
};
