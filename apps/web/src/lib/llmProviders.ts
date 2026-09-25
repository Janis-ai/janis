import {
  MODEL_CATALOG,
  OR_VENDOR_SLUG,
  catalogModel,
  isRateVariant,
  type CatalogModel,
  type LlmEffort,
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

/** The preset serving a catalog vendor — vendors with no first-party
 *  endpoint (meta) route through OpenRouter. */
export function providerForVendor(vendor: LlmVendor | undefined): LlmProvider | undefined {
  if (!vendor) return undefined;
  return LLM_PROVIDERS.find((p) => p.vendor === vendor) ?? providerFor('openrouter');
}

/** Catalog lookup tolerant of `vendor/id` compounds (stored OpenRouter ids). */
export function catalogForId(id: string) {
  return catalogModel(id) ?? catalogModel(id.slice(id.lastIndexOf('/') + 1));
}

/** Longest-prefix catalog match — dated/live variants like
 *  'claude-haiku-4-5-20251001' or 'gemini-3.5-flash-latest' inherit their
 *  family's price/ctx/efforts even though the exact id isn't catalogued. */
export function catalogPrefixFor(id: string): CatalogModel | undefined {
  const bare = id.slice(id.lastIndexOf('/') + 1);
  let best: CatalogModel | undefined;
  for (const m of MODEL_CATALOG) {
    if (isRateVariant(id, m.id) || isRateVariant(bare, m.id)) {
      if (!best || m.id.length > best.id.length) best = m;
    }
  }
  return best;
}

/** Picker options straight from the catalog — optionally vendor-scoped. */
export function catalogOptions(vendors?: LlmVendor[]): ModelOption[] {
  return MODEL_CATALOG.filter((m) => !vendors || vendors.includes(m.vendor)).map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    ctx: m.ctx,
    efforts: m.efforts,
    price: m.price,
  }));
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
  /** Context window tokens (catalog). */
  ctx?: number;
  /** Reasoning-effort levels the model accepts (catalog). */
  efforts?: LlmEffort[];
  /** Catalog price per 1M — drives the cost meter + detail breakdown. */
  price?: { input: number; output: number; cached?: number };
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
      ctx: m.ctx,
      efforts: m.efforts,
      price: m.price,
    }));
  }
  const cataloged = MODEL_CATALOG.filter((m) => m.vendor === p.vendor).map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    ctx: m.ctx,
    efforts: m.efforts,
    price: m.price,
  }));
  const seen = new Set(cataloged.map((m) => m.id));
  return [
    ...cataloged,
    ...(p.extraModels ?? [])
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, name: catalogModel(id)?.name ?? id })),
  ];
}

/** Rate lookup by id for the picker hint — tries the raw id, the
 *  provider-native id inside a `vendor/id` compound (OpenRouter style),
 *  then longest-prefix so 'gemini-3.5-flash-latest' inherits the
 *  'gemini-3.5-flash' rate (the server's rateFor does the same). */
export function catalogRateFor(id: string) {
  const direct = catalogModel(id);
  if (direct?.price) return direct.price;
  const bare = id.slice(id.lastIndexOf('/') + 1);
  const bareHit = bare !== id ? catalogModel(bare) : undefined;
  if (bareHit?.price) return bareHit.price;
  let best: { input: number; output: number } | null = null;
  let bestLen = -1;
  for (const m of MODEL_CATALOG) {
    if (!m.price || m.id.length <= bestLen) continue;
    if (isRateVariant(id, m.id) || isRateVariant(bare, m.id)) {
      best = m.price;
      bestLen = m.id.length;
    }
  }
  return best;
}

/** Live /models lists include image/video/audio generators, embeddings,
 *  previews and tools — none of which can run a chat loop. Filter them. */
const NON_CHAT =
  /embed|imagen|image|veo|lyria|banana|sora|tts|audio|video|realtime|live|aqa|deep-research|antigravity|robotics|computer-use|moderation|transcrib|whisper|dall-e|guard|shield|search|codey|text-(bison|unicorn)/i;

/** Chat-model id families per vendor — live ids outside these are dropped. */
const VENDOR_RX: Partial<Record<LlmVendor, RegExp>> = {
  openai: /^(gpt-|o\d|chatgpt-)/i,
  anthropic: /^claude-/i,
  google: /^gemini-/i,
  xai: /^grok-/i,
  deepseek: /^deepseek-/i,
  moonshot: /^(kimi|moonshot)/i,
  zai: /^glm/i,
  mistral: /^(mistral|magistral|codestral|pixtral|devstral|ministral)/i,
  nvidia: /^(nvidia\/|nemotron|llama)/i,
};

/** Best-effort display name for a live id the catalog doesn't know —
 *  'gemini-3.1-flash-lite-preview' → 'Gemini 3.1 Flash Lite · preview'. */
const KNOWN_TOKEN: Record<string, string> = {
  gemini: 'Gemini', gpt: 'GPT', claude: 'Claude', grok: 'Grok', glm: 'GLM',
  kimi: 'Kimi', llama: 'Llama', mistral: 'Mistral', magistral: 'Magistral',
  codestral: 'Codestral', pixtral: 'Pixtral', devstral: 'Devstral',
  ministral: 'Ministral', deepseek: 'DeepSeek', nemotron: 'Nemotron',
  qwen: 'Qwen', nvidia: 'NVIDIA', flash: 'Flash', lite: 'Lite', pro: 'Pro',
  ultra: 'Ultra', nano: 'Nano', mini: 'Mini', turbo: 'Turbo', it: 'IT',
};

export function prettifyModelName(id: string): string {
  let bare = id.slice(id.lastIndexOf('/') + 1);
  // dated variants: '-20251001' or '-2025-10-01' → a clean '· 2025-10-01'
  const dateHit = bare.match(/-(\d{4})-?(\d{2})-?(\d{2})$/);
  const dateSuffix = dateHit ? `${dateHit[1]}-${dateHit[2]}-${dateHit[3]}` : null;
  if (dateHit) bare = bare.slice(0, -dateHit[0].length);
  const suffixes: string[] = [...(dateSuffix ? [dateSuffix] : [])];
  const words = bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((tok) => {
      const low = tok.toLowerCase();
      if (['preview', 'latest', 'exp', 'experimental', 'beta', 'customtools'].includes(low)) {
        suffixes.push(low === 'customtools' ? 'custom tools' : low);
        return '';
      }
      if (KNOWN_TOKEN[low]) return KNOWN_TOKEN[low];
      if (/^o\d/.test(low)) return low.toUpperCase(); // o1, o3, o4-mini…
      if (/^\d/.test(low)) return low.toUpperCase(); // 3.1, 31b…
      return low[0].toUpperCase() + low.slice(1);
    })
    .filter(Boolean);
  const name = words.join(' ');
  return suffixes.length ? `${name} · ${suffixes.join(', ')}` : name;
}

/** Normalize + filter raw /models ids into picker options. Gemini returns
 *  'models/gemini-…' — the strip is needed for both matching and the id we
 *  send back in chat requests. */
export function filterLiveModels(providerId: string, ids: string[]): ModelOption[] {
  const p = providerFor(providerId);
  const out: ModelOption[] = [];
  for (const raw of ids) {
    const id = raw.replace(/^models\//, '');
    const bare = id.slice(id.lastIndexOf('/') + 1);
    const cat = catalogModel(id) ?? catalogModel(bare);
    // relabel variants (dates, -latest, -preview) inherit the family's
    // metadata (price, ctx, efforts) — also fills gaps field-by-field for
    // catalogued-but-unpriced entries; version bumps/tiers never inherit
    const family = catalogPrefixFor(id);
    const meta = cat ? { ...family, ...cat } : family;
    if (!cat) {
      if (!p) continue;
      if (p.id === 'custom') {
        // self-hosted — can't guess a family, keep everything non-media
        if (NON_CHAT.test(id)) continue;
      } else if (p.id === 'openrouter') {
        // thousands of ids; the catalog already covers what matters
        continue;
      } else {
        const rx = p.vendor ? VENDOR_RX[p.vendor] : undefined;
        if (rx && !rx.test(id)) continue;
        if (NON_CHAT.test(id)) continue;
      }
    }
    out.push({
      id,
      name: cat?.name ?? prettifyModelName(id),
      vendor: meta?.vendor ?? p?.vendor,
      ctx: meta?.ctx,
      efforts: meta?.efforts,
      price: meta?.price,
    });
  }
  return out;
}
