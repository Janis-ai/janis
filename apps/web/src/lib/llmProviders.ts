import {
  MODEL_CATALOG,
  OR_VENDOR_SLUG,
  catalogModel,
  type LlmVendor,
} from '@janis/shared';

/** BYOK LLM provider presets for the Engine tab. Every entry speaks the
 *  OpenAI-compatible chat-completions API, so hosted agents only need a
 *  base_url + key + model. Model options come from the shared catalog
 *  (filtered by vendor) plus the endpoint's live /models list. */
export interface LlmProvider {
  id: string;
  label: string;
  /** Fixed for real providers; empty on 'custom' (user edits base_url). */
  baseUrl?: string;
  /** Catalog vendor whose models this endpoint serves; undefined = all
   *  (OpenRouter) or none (custom). */
  vendor?: LlmVendor;
  /** Extra raw model ids not in the catalog (e.g. Groq's compound ids). */
  extraModels?: string[];
  keyHint?: string;
  keyUrl?: string;
  oauth?: 'openrouter';
}

export const METERED = 'janis';

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    vendor: 'openai',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    vendor: 'anthropic',
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    vendor: 'google',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (all models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-v1-…',
    keyUrl: 'https://openrouter.ai/keys',
    oauth: 'openrouter',
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    vendor: 'xai',
    keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    vendor: 'deepseek',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    vendor: 'moonshot',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    id: 'zai',
    label: 'Z.ai GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    vendor: 'zai',
    keyHint: '…',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    vendor: 'nvidia',
    keyHint: 'nvapi-…',
    keyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    extraModels: [
      'openai/gpt-oss-120b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'moonshotai/kimi-k2-instruct',
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    vendor: 'mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
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

export interface ModelOption {
  /** The id sent to the endpoint (vendor-prefixed for OpenRouter). */
  id: string;
  /** Display name — falls back to id for uncatalogued models. */
  name: string;
  vendor?: LlmVendor;
}

/** Catalog models a provider can serve. OpenRouter reaches every vendor via
 *  `<slug>/<id>` ids (or the catalog's `or` override); vendors see their own;
 *  custom endpoints get nothing (live /models + free text only). */
export function modelsForProvider(providerId: string): ModelOption[] {
  const p = providerFor(providerId);
  if (!p) return [];
  if (p.id === 'openrouter') {
    return MODEL_CATALOG.map((m) => ({
      id: m.or ?? `${OR_VENDOR_SLUG[m.vendor]}/${m.id}`,
      name: m.name,
      vendor: m.vendor,
    }));
  }
  const cataloged = MODEL_CATALOG.filter((m) => m.vendor === p.vendor).map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
  }));
  const seen = new Set(cataloged.map((m) => m.id));
  return [
    ...cataloged,
    ...(p.extraModels ?? [])
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, name: catalogModel(id)?.name ?? id })),
  ];
}

/** Rate lookup by id for the picker hint — tries the raw id, then the
 *  provider-native id inside a `vendor/id` compound (OpenRouter style). */
export function catalogRateFor(id: string) {
  const direct = catalogModel(id);
  if (direct) return direct.price ?? null;
  const slash = id.indexOf('/');
  if (slash > 0) return catalogModel(id.slice(slash + 1))?.price ?? null;
  return null;
}
