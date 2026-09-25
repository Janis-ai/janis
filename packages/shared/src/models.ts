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

export interface CatalogModel {
  /** Provider-native API id (what gets sent to the endpoint). */
  id: string;
  /** Display name in the picker. */
  name: string;
  vendor: LlmVendor;
  /** OpenRouter id when it differs from `vendorSlug/id` conventions. */
  or?: string;
  /** USD per 1M tokens {input, output}. Only verified prices. */
  price?: { input: number; output: number };
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

export const MODEL_CATALOG: CatalogModel[] = [
  // --- OpenAI ---
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', vendor: 'openai', price: { input: 10, output: 50 } },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', vendor: 'openai', price: { input: 2, output: 10 } },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'openai', price: { input: 0.1, output: 0.5 } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'openai', price: { input: 4, output: 20 } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vendor: 'openai', price: { input: 2, output: 12 } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', price: { input: 0.2, output: 1.2 } },
  { id: 'gpt-5.5', name: 'GPT-5.5', vendor: 'openai', price: { input: 1.5, output: 12 } },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', vendor: 'openai', price: { input: 0.4, output: 1.6 } },
  { id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'openai', price: { input: 1.5, output: 12 } },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', vendor: 'openai', price: { input: 1.5, output: 12 } },
  { id: 'gpt-5.2', name: 'GPT-5.2', vendor: 'openai', price: { input: 1.25, output: 10 } },
  { id: 'gpt-5.1', name: 'GPT-5.1', vendor: 'openai', price: { input: 1.25, output: 10 } },
  { id: 'gpt-5', name: 'GPT-5', vendor: 'openai', price: { input: 1.25, output: 10 } },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', vendor: 'openai', price: { input: 0.25, output: 2 } },
  { id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'openai', price: { input: 2, output: 8 } },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', vendor: 'openai', price: { input: 0.4, output: 1.6 } },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', vendor: 'openai', price: { input: 0.1, output: 0.4 } },
  { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai', price: { input: 2.5, output: 10 } },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', vendor: 'openai', price: { input: 0.15, output: 0.6 } },
  // --- Anthropic ---
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', vendor: 'anthropic', price: { input: 10, output: 50 } },
  { id: 'claude-fable-5', name: 'Claude Fable 5', vendor: 'anthropic', price: { input: 10, output: 50 } },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vendor: 'anthropic', price: { input: 4, output: 20 } },
  { id: 'claude-opus-5', name: 'Claude Opus 5', vendor: 'anthropic', price: { input: 5, output: 25 } },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', vendor: 'anthropic', price: { input: 5, output: 25 } },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', vendor: 'anthropic', price: { input: 5, output: 25 } },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', vendor: 'anthropic', price: { input: 5, output: 25 } },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', vendor: 'anthropic', price: { input: 5, output: 25 } },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'anthropic', price: { input: 2, output: 10 } },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vendor: 'anthropic', price: { input: 3, output: 15 } },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', price: { input: 3, output: 15 } },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', vendor: 'anthropic', price: { input: 1, output: 5 } },
  // --- Google Gemini ---
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', vendor: 'google', price: { input: 0.75, output: 3.75 } },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', vendor: 'google', price: { input: 0.75, output: 3.75 } },
  { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro', vendor: 'google', price: { input: 2, output: 12 } },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', vendor: 'google', price: { input: 0.75, output: 3.75 } },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', vendor: 'google', price: { input: 0.3, output: 2.5 } },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', vendor: 'google', price: { input: 1.5, output: 9 } },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', vendor: 'google', price: { input: 2, output: 12 } },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', vendor: 'google', price: { input: 0.25, output: 1.5 } },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', vendor: 'google', price: { input: 0.3, output: 2.5 } },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'google', price: { input: 1.25, output: 10 } },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', vendor: 'google', price: { input: 0.3, output: 2.5 } },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', vendor: 'google', price: { input: 0.1, output: 0.4 } },
  // --- xAI ---
  { id: 'grok-4.6', name: 'Grok 4.6 (beta)', vendor: 'xai' },
  { id: 'grok-4.5', name: 'Grok 4.5', vendor: 'xai', price: { input: 3, output: 15 } },
  { id: 'grok-4-fast', name: 'Grok 4 Fast', vendor: 'xai', price: { input: 0.2, output: 0.5 } },
  { id: 'grok-4', name: 'Grok 4', vendor: 'xai', price: { input: 3, output: 15 } },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', vendor: 'xai', price: { input: 0.3, output: 0.5 } },
  { id: 'grok-3', name: 'Grok 3', vendor: 'xai', price: { input: 3, output: 15 } },
  // --- DeepSeek ---
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vendor: 'deepseek' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vendor: 'deepseek' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vendor: 'deepseek', price: { input: 0.44, output: 1.32 } },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', vendor: 'deepseek', price: { input: 0.55, output: 2.19 } },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', vendor: 'deepseek', price: { input: 0.28, output: 0.42 } },
  // --- Moonshot Kimi ---
  { id: 'kimi-k3', name: 'Kimi K3', vendor: 'moonshot' },
  { id: 'kimi-k2.7', name: 'Kimi K2.7', vendor: 'moonshot' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', vendor: 'moonshot' },
  { id: 'kimi-k2', name: 'Kimi K2', vendor: 'moonshot', price: { input: 0.6, output: 2.5 } },
  // --- Z.ai GLM ---
  { id: 'glm-5.3-max', name: 'GLM-5.3 Max', vendor: 'zai' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', vendor: 'zai' },
  { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'zai' },
  { id: 'glm-5.2', name: 'GLM-5.2', vendor: 'zai', price: { input: 0.6, output: 2.2 } },
  // --- NVIDIA ---
  { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', vendor: 'nvidia', or: 'nvidia/nemotron-3-ultra' },
  // --- Mistral / Meta (open weight) ---
  { id: 'mistral-large-latest', name: 'Mistral Large', vendor: 'mistral', price: { input: 2, output: 6 } },
  { id: 'mistral-medium-latest', name: 'Mistral Medium', vendor: 'mistral', price: { input: 0.4, output: 2 } },
  { id: 'codestral-latest', name: 'Codestral', vendor: 'mistral', price: { input: 0.3, output: 0.9 } },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', vendor: 'meta', or: 'meta-llama/llama-3.3-70b-instruct', price: { input: 0.59, output: 0.79 } },
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
