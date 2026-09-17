import type { agents } from '../db/schema.js';
import { env } from '../env.js';

export interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
export function llmFor(agent: typeof agents.$inferSelect): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: { api_key?: string; base_url?: string; model?: string };
  };
  return {
    apiKey: cfg.llm?.api_key || env.llmApiKey,
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/$/, ''),
    model: cfg.llm?.model || env.llmModel,
  };
}
