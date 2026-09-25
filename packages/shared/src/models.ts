/** The frontier model catalog — single source for API ids, display names,
 *  vendors and per-1M-token prices. The web model picker renders names +
 *  vendor icons; the API rate card derives from `price` (verified Sep 2026;
 *  omit price when unverified rather than guessing on the metered bill). */
export type LlmVendor =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'moonshot'
  | 'zai'
  | 'nvidia'
  | 'mistral'
  | 'meta';

/** Reasoning-effort levels, cheapest→most. 'max' only on vendors that
 *  expose a fourth tier. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'] as const;
export type LlmEffort = (typeof EFFORT_LEVELS)[number];

export interface CatalogModel {
  /** Provider-native API id (what gets sent to the endpoint). */
  id: string;
  /** Display name in the picker. */
  name: string;
  vendor: LlmVendor;
  /** OpenRouter id when it differs from `vendorSlug/id` conventions. */
  or?: string;
  /** USD per 1M tokens {input, output, cached input read}. Only verified
   *  prices — omit `cached` when the provider doesn't publish one. */
  price?: { input: number; output: number; cached?: number };
  /** Context window in tokens, for the picker's detail panel. */
  ctx?: number;
  /** Reasoning-effort levels the model accepts (omit = non-reasoning
   *  model — effort params are never sent). */
  efforts?: LlmEffort[];
}

/** OpenRouter prefixes model ids by vendor slug. */
export const OR_VENDOR_SLUG: Record<LlmVendor, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'x-ai',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  zai: 'z-ai',
  nvidia: 'nvidia',
  mistral: 'mistralai',
  meta: 'meta-llama',
};

// Effort/caching shorthand: REASONING = standard low→high; E4 adds 'max'
// (Anthropic's newest tier). Anthropic cache reads are a documented 10% of
// input; Google/OpenAI's recent cached-input rate is ~10% too.
const REASONING: LlmEffort[] = ['low', 'medium', 'high'];
const E4: LlmEffort[] = ['low', 'medium', 'high', 'max'];
const M1 = 1_000_000;

export const MODEL_CATALOG: CatalogModel[] = [
  // --- OpenAI ---
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', vendor: 'openai', ctx: M1, efforts: E4, price: { input: 10, output: 50, cached: 1 } },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', vendor: 'openai', ctx: M1, efforts: E4, price: { input: 2, output: 10, cached: 0.2 } },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'openai', ctx: M1, efforts: E4, price: { input: 0.1, output: 0.5, cached: 0.01 } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 4, output: 20, cached: 0.4 } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 2, output: 12, cached: 0.2 } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 0.2, output: 1.2, cached: 0.02 } },
  { id: 'gpt-5.5', name: 'GPT-5.5', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.5, output: 12, cached: 0.15 } },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 0.4, output: 1.6, cached: 0.04 } },
  { id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.5, output: 12, cached: 0.15 } },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.5, output: 12, cached: 0.15 } },
  { id: 'gpt-5.2', name: 'GPT-5.2', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.25, output: 10, cached: 0.125 } },
  { id: 'gpt-5.1', name: 'GPT-5.1', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.25, output: 10, cached: 0.125 } },
  { id: 'gpt-5', name: 'GPT-5', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 1.25, output: 10, cached: 0.125 } },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', vendor: 'openai', ctx: 400_000, efforts: REASONING, price: { input: 0.25, output: 2, cached: 0.025 } },
  { id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'openai', ctx: M1, price: { input: 2, output: 8, cached: 0.5 } },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', vendor: 'openai', ctx: M1, price: { input: 0.4, output: 1.6, cached: 0.1 } },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', vendor: 'openai', ctx: M1, price: { input: 0.1, output: 0.4, cached: 0.025 } },
  { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai', ctx: 128_000, price: { input: 2.5, output: 10, cached: 1.25 } },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', vendor: 'openai', ctx: 128_000, price: { input: 0.15, output: 0.6, cached: 0.075 } },
  // --- Anthropic --- (cache reads are documented at 10% of input)
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', vendor: 'anthropic', ctx: M1, efforts: E4, price: { input: 10, output: 50, cached: 1 } },
  { id: 'claude-fable-5', name: 'Claude Fable 5', vendor: 'anthropic', ctx: M1, efforts: E4, price: { input: 10, output: 50, cached: 1 } },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vendor: 'anthropic', ctx: M1, efforts: E4, price: { input: 4, output: 20, cached: 0.4 } },
  { id: 'claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic', ctx: M1, efforts: E4, price: { input: 5, output: 25, cached: 0.5 } },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 5, output: 25, cached: 0.5 } },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 5, output: 25, cached: 0.5 } },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 5, output: 25, cached: 0.5 } },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 5, output: 25, cached: 0.5 } },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'anthropic', ctx: M1, efforts: REASONING, price: { input: 2, output: 10, cached: 0.2 } },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 3, output: 15, cached: 0.3 } },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 3, output: 15, cached: 0.3 } },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', vendor: 'anthropic', ctx: 200_000, efforts: REASONING, price: { input: 1, output: 5, cached: 0.1 } },
  // --- Google Gemini ---
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.75, output: 3.75, cached: 0.075 } },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.75, output: 3.75, cached: 0.075 } },
  { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 2, output: 12, cached: 0.2 } },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.75, output: 3.75, cached: 0.075 } },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.3, output: 2.5, cached: 0.03 } },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 1.5, output: 9, cached: 0.15 } },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 2, output: 12, cached: 0.2 } },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.25, output: 1.5, cached: 0.025 } },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.3, output: 2.5, cached: 0.03 } },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 1.25, output: 10, cached: 0.31 } },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.3, output: 2.5, cached: 0.075 } },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', vendor: 'google', ctx: M1, efforts: REASONING, price: { input: 0.1, output: 0.4, cached: 0.01 } },
  // --- xAI ---
  { id: 'grok-4.6', name: 'Grok 4.6 (beta)', vendor: 'xai', ctx: 256_000, efforts: ['low', 'high'] },
  { id: 'grok-4.5', name: 'Grok 4.5', vendor: 'xai', ctx: 256_000, efforts: ['low', 'high'], price: { input: 3, output: 15 } },
  { id: 'grok-4-fast', name: 'Grok 4 Fast', vendor: 'xai', ctx: 2_000_000, efforts: ['low', 'high'], price: { input: 0.2, output: 0.5 } },
  { id: 'grok-4', name: 'Grok 4', vendor: 'xai', ctx: 256_000, efforts: ['low', 'high'], price: { input: 3, output: 15 } },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', vendor: 'xai', ctx: 128_000, efforts: ['low', 'high'], price: { input: 0.3, output: 0.5 } },
  { id: 'grok-3', name: 'Grok 3', vendor: 'xai', ctx: 128_000, price: { input: 3, output: 15 } },
  // --- DeepSeek --- (context caching documented; cache hit ≈ ¼ of input)
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vendor: 'deepseek', ctx: 128_000, efforts: REASONING },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vendor: 'deepseek', ctx: 128_000, efforts: REASONING },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vendor: 'deepseek', ctx: 128_000, efforts: REASONING, price: { input: 0.44, output: 1.32, cached: 0.11 } },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', vendor: 'deepseek', ctx: 128_000, efforts: REASONING, price: { input: 0.55, output: 2.19, cached: 0.14 } },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', vendor: 'deepseek', ctx: 128_000, price: { input: 0.28, output: 0.42, cached: 0.07 } },
  // --- Moonshot Kimi ---
  { id: 'kimi-k3', name: 'Kimi K3', vendor: 'moonshot', ctx: 256_000, efforts: REASONING },
  { id: 'kimi-k2.7', name: 'Kimi K2.7', vendor: 'moonshot', ctx: 256_000, efforts: REASONING },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', vendor: 'moonshot', ctx: 256_000, efforts: REASONING },
  { id: 'kimi-k2', name: 'Kimi K2', vendor: 'moonshot', ctx: 256_000, efforts: REASONING, price: { input: 0.6, output: 2.5, cached: 0.15 } },
  // --- Z.ai GLM ---
  { id: 'glm-5.3-max', name: 'GLM-5.3 Max', vendor: 'zai', ctx: 200_000, efforts: REASONING },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', vendor: 'zai', ctx: 200_000, efforts: REASONING },
  { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'zai', ctx: 200_000, efforts: REASONING },
  { id: 'glm-5.2', name: 'GLM-5.2', vendor: 'zai', ctx: 200_000, efforts: REASONING, price: { input: 0.6, output: 2.2, cached: 0.12 } },
  // --- NVIDIA ---
  { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', vendor: 'nvidia', or: 'nvidia/nemotron-3-ultra', efforts: REASONING },
  // --- Mistral / Meta (open weight) ---
  { id: 'mistral-large-latest', name: 'Mistral Large', vendor: 'mistral', ctx: 128_000, efforts: REASONING, price: { input: 2, output: 6 } },
  { id: 'mistral-medium-latest', name: 'Mistral Medium', vendor: 'mistral', ctx: 128_000, price: { input: 0.4, output: 2 } },
  { id: 'codestral-latest', name: 'Codestral', vendor: 'mistral', ctx: 256_000, price: { input: 0.3, output: 0.9 } },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', vendor: 'meta', or: 'meta-llama/llama-3.3-70b-instruct', ctx: 128_000, price: { input: 0.59, output: 0.79 } },
];

export function catalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** OpenAI-compatible chat endpoint per vendor — used to detect which vendor
 *  a Janis metered env key serves, and as BYOK preset base URLs. '' = no
 *  first-party endpoint (meta → OpenRouter or self-hosted). */
export const VENDOR_ENDPOINTS: Record<LlmVendor, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.ai/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  meta: '',
};

/** Which vendor a base_url belongs to (trailing slashes ignored). */
export function vendorForBaseUrl(baseUrl: string): LlmVendor | undefined {
  const norm = baseUrl.replace(/\/+$/, '');
  return (Object.entries(VENDOR_ENDPOINTS) as [LlmVendor, string][]).find(
    ([, url]) => url && url === norm,
  )?.[0];
}

/** Effort level to send on the wire for `model`, or undefined when the
 *  param shouldn't be sent at all. Catalog models without `efforts` are
 *  non-reasoning (a stray reasoning_effort would 400); requested levels the
 *  model lacks snap to the nearest supported. Uncatalogued models pass the
 *  request through — the user's endpoint, their call. */
export function effortFor(id: string, effort: string | undefined): LlmEffort | undefined {
  if (!effort) return undefined;
  const m = catalogModel(id) ?? catalogModel(id.slice(id.lastIndexOf('/') + 1));
  if (!m) return effort as LlmEffort;
  if (!m.efforts?.length) return undefined;
  if ((m.efforts as string[]).includes(effort)) return effort as LlmEffort;
  // snap to the nearest supported level
  const want = EFFORT_LEVELS.indexOf(effort as LlmEffort);
  return [...m.efforts].sort(
    (a, b) =>
      Math.abs(EFFORT_LEVELS.indexOf(a) - want) - Math.abs(EFFORT_LEVELS.indexOf(b) - want),
  )[0];
}
