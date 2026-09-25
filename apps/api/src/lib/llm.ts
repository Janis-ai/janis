import type { agents } from '../db/schema.js';
import { env } from '../env.js';
import { VENDOR_ENDPOINTS, catalogModel, vendorForBaseUrl, type LlmVendor } from '@janis/shared';

export interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
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
}

/** Provider accounts Janis can meter against: the JANIS_LLM_API_KEY/
 *  JANIS_LLM_BASE_URL pair (always first = default) plus any vendor-keyed
 *  entries in JANIS_LLM_PROVIDERS. */
export function meteredAccounts(): MeteredAccount[] {
  const accs: MeteredAccount[] = [];
  // the env pair is always the default account — key optional (local
  // endpoints are keyless; a missing key on a real provider just 401s)
  accs.push({
    vendor: vendorForBaseUrl(env.llmBaseUrl) ?? 'default',
    apiKey: env.llmApiKey,
    baseUrl: env.llmBaseUrl.replace(/\/+$/, ''),
  });
  for (const [vendor, a] of Object.entries(env.janisLlmProviders)) {
    const baseUrl = (
      a.base_url ||
      VENDOR_ENDPOINTS[vendor as LlmVendor] ||
      ''
    ).replace(/\/+$/, '');
    if (!a.api_key || !baseUrl) continue;
    accs.push({ vendor, apiKey: a.api_key, baseUrl });
  }
  return accs;
}

/** The account that serves `model` on Janis's meter — matched by catalog
 *  vendor, else the default account. Throws when the model's vendor has no
 *  configured account (a Gemini key can't answer claude-*). */
export function meteredAccountFor(model: string): MeteredAccount | undefined {
  const accs = meteredAccounts();
  if (!accs.length) return undefined;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const cat = catalogModel(model) ?? catalogModel(bare);
  if (!cat) return accs.find((a) => a.vendor === 'default') ?? accs[0];
  const acc = accs.find((a) => a.vendor === cat.vendor);
  if (!acc) {
    throw new Error(
      `Janis has no ${cat.vendor} provider account configured — add one via JANIS_LLM_PROVIDERS or switch this agent to BYOK`,
    );
  }
  return acc;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
export function llmFor(agent: typeof agents.$inferSelect): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: { api_key?: string; base_url?: string; model?: string; provider?: string };
  };
  const model = cfg.llm?.model || env.llmModel;
  const metered =
    cfg.llm?.provider === 'janis' ||
    (!cfg.llm?.api_key && !cfg.llm?.base_url && !cfg.llm?.provider);
  if (metered) {
    const acc = meteredAccountFor(model);
    return {
      apiKey: acc?.apiKey ?? env.llmApiKey,
      baseUrl: (acc?.baseUrl ?? env.llmBaseUrl).replace(/\/+$/, ''),
      model,
      byok: false,
    };
  }
  // A custom endpoint without a key never gets ours — sending env.llmApiKey
  // to a customer-controlled base_url would leak it. Same for an explicit
  // BYOK provider selection with no key saved yet.
  return {
    apiKey: cfg.llm?.api_key ?? '',
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/+$/, ''),
    model,
    byok: Boolean(cfg.llm?.api_key) || Boolean(cfg.llm?.base_url || cfg.llm?.provider),
  };
}
