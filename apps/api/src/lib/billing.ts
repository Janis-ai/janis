import { env } from '../env.js';

// USD per 1M tokens — what WE pay providers (cost basis, margin added on top).
// Extend/override via LLM_PRICES env JSON: {"my-model":{"input":0.5,"output":1.5}}
// Prefix-matched in insertion order — put longer/shared prefixes FIRST
// (gemini-3.5-flash-lite before gemini-3.5-flash, claude-opus-5-5 before
// claude-opus-5). Prices verified Sep 2026 (ai.google.dev, platform.claude.com,
// developers.openai.com).
const RATE_CARD: Record<string, { input: number; output: number }> = {
  // --- OpenAI ---
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // --- Anthropic ---
  'claude-fable-5': { input: 10, output: 50 }, // covers -5 and -5-1 (same price)
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 }, // before claude-opus-5!
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // --- Gemini (the metered provider) ---
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 }, // before -flash!
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 }, // intro price thru Dec 2026 → 1.5/7.5 after
  'gemini-3.7-flash': { input: 0.75, output: 3.75 }, // intro price thru Dec 2026 → 1.5/7.5 after
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.7-pro': { input: 2, output: 12 }, // pro-tier estimate — verify when Google publishes
  'gemini-3.1-pro': { input: 2, output: 12 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // --- xAI ---
  'grok-4-fast': { input: 0.2, output: 0.5 }, // before grok-4!
  'grok-4': { input: 3, output: 15 },
  'grok-3-mini': { input: 0.3, output: 0.5 }, // before grok-3!
  'grok-3': { input: 3, output: 15 },
  // --- DeepSeek / Mistral ---
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'mistral-large': { input: 2, output: 6 },
  'mistral-medium': { input: 0.4, output: 2 },
  'codestral': { input: 0.3, output: 0.9 },
  // self-hosted (Ollama/vLLM/Groq unknown) — assume cheap
  default: { input: 0.5, output: 1.5 },
};

/** The full card + margin, for UI rate display. */
export function allRates() {
  return { rates: RATE_CARD, margin: billingConfig.margin };
}

/** Resolve a model to its per-1M cost basis (prefix match → default). */
export function rateFor(model: string | null | undefined) {
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
