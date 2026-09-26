import type { agents } from '../db/schema.js';
import { env } from '../env.js';
import { VENDOR_ENDPOINTS, OR_VENDOR_SLUG, catalogModel, vendorForBaseUrl, type LlmVendor } from '@janis/shared';
import { pricedRateFor } from './billing.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Extra request headers the provider needs alongside Bearer auth
   *  (e.g. anthropic-version / anthropic-workspace-id). */
  headers?: Record<string, string>;
  /** Reasoning effort from agent config — sent as the provider's effort
   *  param when the serving model supports it (see effortFor). */
  effort?: string;
  /** True when the agent runs on its own credentials/endpoint — tokens are
   *  paid to their provider, so Janis must not meter them at cost+margin. */
  byok: boolean;
}

export interface MeteredAccount {
  /** Catalog vendor id, or 'default' for the env account when its base_url
   *  doesn't match a known vendor. */
  vendor: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

/** Provider accounts Janis can meter against: the JANIS_LLM_API_KEY/
 *  JANIS_LLM_BASE_URL pair (always first = default) plus any vendor-keyed
 *  entries in JANIS_LLM_PROVIDERS. */
export function meteredAccounts(): MeteredAccount[] {
  const accs: MeteredAccount[] = [];
  // the env pair is always the default account — key optional (local
  // endpoints are keyless; a missing key on a real provider just 401s)
  const defaultVendor = vendorForBaseUrl(env.llmBaseUrl) ?? 'default';
  accs.push({
    vendor: defaultVendor,
    apiKey: env.llmApiKey,
    baseUrl: env.llmBaseUrl.replace(/\/+$/, ''),
    ...(defaultVendor === 'anthropic' ? { headers: anthropicHeaders() } : {}),
  });
  const upsert = (acc: MeteredAccount) => {
    const i = accs.findIndex((a) => a.vendor === acc.vendor);
    if (i >= 0) accs[i] = acc;
    else accs.push(acc);
  };
  // <VENDOR>_LLM_API_KEY entries override the legacy pair on the same
  // vendor; JANIS_LLM_PROVIDERS JSON overrides everything.
  for (const source of [env.llmVendorKeys, env.janisLlmProviders]) {
    for (const [vendor, a] of Object.entries(source)) {
      const baseUrl = (
        a.base_url ||
        (vendor === 'openrouter' ? OPENROUTER_BASE_URL : VENDOR_ENDPOINTS[vendor as LlmVendor]) ||
        ''
      ).replace(/\/+$/, '');
      if (!a.api_key || !baseUrl) continue;
      upsert({
        vendor,
        apiKey: a.api_key,
        baseUrl,
        ...(vendor === 'anthropic' ? { headers: anthropicHeaders() } : {}),
      });
    }
  }
  return accs;
}

/** Anthropic needs a version header on every call; org-scoped keys also
 *  need the workspace UUID (ANTHROPIC_LLM_WORKSPACE). */
function anthropicHeaders(): Record<string, string> {
  return {
    'anthropic-version': '2023-06-01',
    ...(env.anthropicWorkspace ? { 'anthropic-workspace-id': env.anthropicWorkspace } : {}),
  };
}

/** The account that serves `model` on Janis's meter — matched by catalog
 *  vendor, else an OpenRouter account (routes every vendor by `vendor/id`),
 *  else the default account for uncatalogued models. Throws when the
 *  model's vendor has no configured account (a Gemini key can't answer
 *  claude-*). */
export function meteredAccountFor(model: string): MeteredAccount | undefined {
  const accs = meteredAccounts();
  if (!accs.length) return undefined;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const cat = catalogModel(model) ?? catalogModel(bare);
  if (!cat) return accs.find((a) => a.vendor === 'default') ?? accs[0];
  const acc = accs.find((a) => a.vendor === cat.vendor) ?? accs.find((a) => a.vendor === 'openrouter');
  if (!acc) {
    throw new Error(
      `Janis has no ${cat.vendor} provider account configured — set ${cat.vendor.toUpperCase()}_LLM_API_KEY/OPENROUTER_LLM_API_KEY or switch this agent to BYOK`,
    );
  }
  return acc;
}

/** OpenRouter ids are `vendor/model` compounds — translate a catalog id
 *  when the serving account is OpenRouter. */
export function meteredModelId(acc: MeteredAccount, model: string): string {
  if (acc.vendor !== 'openrouter') return model;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const cat = catalogModel(model) ?? catalogModel(bare);
  return cat ? (cat.or ?? `${OR_VENDOR_SLUG[cat.vendor]}/${cat.id}`) : model;
}

/** Metered settings for a single model — resolves the serving provider
 *  account and translates the id for OpenRouter. Used by llmFor for the
 *  configured model and by the hosted retry loop for the fallback model,
 *  which may live on a different vendor account entirely. */
export function meteredSettingsFor(model: string, effort?: string): LlmSettings {
  const acc = meteredAccountFor(model);
  return {
    apiKey: acc?.apiKey ?? env.llmApiKey,
    baseUrl: (acc?.baseUrl ?? env.llmBaseUrl).replace(/\/+$/, ''),
    model: acc ? meteredModelId(acc, model) : model,
    headers: acc?.headers,
    effort,
    byok: false,
  };
}

/** The model a config would run on Janis's metered accounts, or null when
 *  the config is BYOK (own key, endpoint, or non-janis provider). Used by the
 *  free-plan gate in PATCH /agents — locked workspaces can't move this. */
export function meteredModelOf(config: unknown): string | null {
  const llm = (config as
    | { llm?: { provider?: string; api_key?: string; base_url?: string; model?: string } }
    | null
    | undefined)?.llm;
  const metered =
    llm?.provider === 'janis' || (!llm?.api_key && !llm?.base_url && !llm?.provider);
  return metered ? (llm?.model || env.llmModel) : null;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
export function llmFor(agent: typeof agents.$inferSelect): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: {
      api_key?: string;
      base_url?: string;
      model?: string;
      provider?: string;
      effort?: string;
    };
  };
  const model = cfg.llm?.model || env.llmModel;
  const metered =
    cfg.llm?.provider === 'janis' ||
    (!cfg.llm?.api_key && !cfg.llm?.base_url && !cfg.llm?.provider);
  if (metered) {
    // No verified price = we can't bill correctly — refuse rather than fall
    // back to a guessed default rate.
    if (!pricedRateFor(model)) {
      throw new Error(
        `'${model}' has no metered rate — pick a priced model or switch this agent to BYOK`,
      );
    }
    return meteredSettingsFor(model, cfg.llm?.effort);
  }
  // A custom endpoint without a key never gets ours — sending env.llmApiKey
  // to a customer-controlled base_url would leak it. Same for an explicit
  // BYOK provider selection with no key saved yet.
  return {
    apiKey: cfg.llm?.api_key ?? '',
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/+$/, ''),
    model,
    effort: cfg.llm?.effort,
    byok: Boolean(cfg.llm?.api_key) || Boolean(cfg.llm?.base_url || cfg.llm?.provider),
  };
}
