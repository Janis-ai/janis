import { env } from '../env.js';

// USD per 1M tokens — what WE pay providers (cost basis, margin added on top).
// Extend/override via LLM_PRICES env JSON: {"my-model":{"input":0.5,"output":1.5}}
const RATE_CARD: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // self-hosted (Ollama/vLLM/Groq unknown) — assume cheap
  default: { input: 0.5, output: 1.5 },
};

function rateFor(model: string | null | undefined) {
  if (!model) return RATE_CARD.default;
  const custom = env.llmPrices as Record<string, { input: number; output: number }> | undefined;
  if (custom?.[model]) return custom[model];
  // match prefix so dated variants (gpt-4o-mini-2024-07-18) hit their family
  const key = Object.keys(RATE_CARD).find((k) => k !== 'default' && model.startsWith(k));
  return RATE_CARD[key ?? 'default'];
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

/** Fixed-cost config, USD cents — plan base price lives in plans.ts. */
export const billingConfig = {
  // monthly per connected channel
  channelCents: env.billingChannelCents,
  // margin applied on top of pass-through LLM cost
  margin: env.billingMargin,
};
