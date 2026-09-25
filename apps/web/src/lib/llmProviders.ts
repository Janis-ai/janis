/** BYOK LLM provider presets for the Engine tab. Every entry speaks the
 *  OpenAI-compatible chat-completions API, so hosted agents only need a
 *  base_url + key + model. `models` are curated fallbacks — the UI also
 *  fetches the live /models list once a key is present. */
export interface LlmProvider {
  id: string;
  label: string;
  /** Fixed for real providers; empty on 'custom' (user edits base_url). */
  baseUrl?: string;
  keyHint?: string;
  keyUrl?: string;
  models: string[];
  oauth?: 'openrouter';
}

export const METERED = 'janis';

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      'gemini-3.7-pro',
      'gemini-3.7-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-pro',
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (all models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-v1-…',
    keyUrl: 'https://openrouter.ai/keys',
    oauth: 'openrouter',
    models: [
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-fable-5-1',
      'google/gemini-3.7-flash',
      'x-ai/grok-4',
      'deepseek/deepseek-chat-v3.2',
      'meta-llama/llama-4-maverick',
      'moonshotai/kimi-k2',
    ],
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai',
    models: ['grok-4', 'grok-4-fast', 'grok-3', 'grok-3-mini'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'moonshotai/kimi-k2-instruct',
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'magistral-medium-latest', 'codestral-latest'],
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    models: [],
  },
];

export function providerFor(id: string | undefined): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** Which preset does this saved config correspond to? Matches on base_url;
 *  a key with no base_url is OpenAI (the pre-preset default). */
export function detectProvider(llm?: {
  api_key?: string | null;
  base_url?: string;
  key_set?: boolean;
}): string | undefined {
  if (!llm) return undefined;
  if (llm.base_url) {
    const hit = LLM_PROVIDERS.find(
      (p) => p.baseUrl && llm.base_url!.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, ''),
    );
    return hit?.id ?? 'custom';
  }
  return llm.api_key || llm.key_set ? 'openai' : undefined;
}
