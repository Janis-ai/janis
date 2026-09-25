import type { agents } from '../db/schema.js';
import { env } from '../env.js';

export interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** True when the agent runs on its own credentials/endpoint — tokens are
   *  paid to their provider, so Janis must not meter them at cost+margin. */
  byok: boolean;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
export function llmFor(agent: typeof agents.$inferSelect): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: { api_key?: string; base_url?: string; model?: string; provider?: string };
  };
  // provider 'janis' pins the agent to the metered key — a stored BYOK key is
  // kept (easy switch back) but must not take effect.
  if (cfg.llm?.provider === 'janis') {
    return {
      apiKey: env.llmApiKey,
      baseUrl: env.llmBaseUrl.replace(/\/$/, ''),
      model: cfg.llm.model || env.llmModel,
      byok: false,
    };
  }
  // A custom endpoint without a key never gets ours — sending env.llmApiKey
  // to a customer-controlled base_url would leak it. Same for an explicit
  // BYOK provider selection with no key saved yet.
  const byokIntent = Boolean(cfg.llm?.base_url || cfg.llm?.provider);
  return {
    apiKey: cfg.llm?.api_key || (byokIntent ? '' : env.llmApiKey),
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/$/, ''),
    model: cfg.llm?.model || env.llmModel,
    byok: Boolean(cfg.llm?.api_key) || byokIntent,
  };
}
