import { desc, eq } from 'drizzle-orm';
import type { OutboundWebhook } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, conversations, messages } from '../db/schema.js';
import { env } from '../env.js';
import { processEvents } from '../services/ingest.js';
import { storeSuggestion } from '../services/suggestions.js';
import { recordLlmUsage } from './usage.js';

type AgentRow = typeof agents.$inferSelect;

interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
function llmFor(agent: AgentRow): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: { api_key?: string; base_url?: string; model?: string };
  };
  return {
    apiKey: cfg.llm?.api_key || env.llmApiKey,
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/$/, ''),
    model: cfg.llm?.model || env.llmModel,
  };
}

function systemPrompt(agent: AgentRow): string {
  const cfg = (agent.config ?? {}) as {
    system_prompt?: string;
    knowledge?: string[];
    tone?: string;
  };
  const parts = [
    cfg.system_prompt ||
      'You are a helpful support agent. Answer concisely and accurately. If you are unsure, or the request needs a human, reply with exactly: [HANDOFF]',
  ];
  if (cfg.knowledge?.length) {
    parts.push(`\nKnowledge base:\n${cfg.knowledge.map((k) => `- ${k}`).join('\n')}`);
  }
  if (cfg.tone) parts.push(`\nTone: ${cfg.tone}`);
  parts.push('\nIf the user asks for a human or you cannot help, reply with exactly: [HANDOFF]');
  return parts.join('');
}

interface Completion {
  text: string | null;
  promptTokens: number;
  completionTokens: number;
}

async function complete(
  llm: LlmSettings,
  system: string,
  history: { role: string; content: string }[],
): Promise<Completion> {
  const empty = { text: null, promptTokens: 0, completionTokens: 0 };
  if (!llm.apiKey) return empty;
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({ model: llm.model, max_tokens: 400, messages: [{ role: 'system', content: system }, ...history] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content?.trim() ?? null;
  // Some OpenAI-compatible endpoints omit `usage` — estimate chars/4 rather
  // than bill zero
  const promptTokens =
    json.usage?.prompt_tokens ??
    Math.ceil((system.length + history.reduce((n, m) => n + m.content.length, 0)) / 4);
  const completionTokens =
    json.usage?.completion_tokens ?? (text ? Math.ceil(text.length / 4) : 0);
  return { text, promptTokens, completionTokens };
}

async function transcriptFor(db: Db, convId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return rows
    .reverse()
    .filter((m) => m.text)
    .map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.direction === 'human' ? `(human operator) ${m.text}` : m.text!,
    }));
}

/**
 * In-process agent runtime: same behavior as packages/agent-template, but
 * driven by Janis directly — no webhook_url, no client infra. Replies are
 * ingested as message_out events, which also deliver to the bound channel.
 */
export async function runHostedEvent(
  db: Db,
  agent: AgentRow,
  event: OutboundWebhook,
): Promise<void> {
  if (event.type === 'suggestion.request') {
    const convId = event.janis_conversation_id;
    if (!convId) return;
    const llm = llmFor(agent);
    const history = await transcriptFor(db, convId);
    const result = await complete(llm, systemPrompt(agent), history).catch(() => null);
    if (result) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
    }
    const draft = result?.text;
    const text =
      draft && !draft.includes('[HANDOFF]')
        ? draft
        : 'I want to make sure we get this right — let me look into it and follow up shortly.';
    await storeSuggestion(db, convId, text, 'agent');
    return;
  }

  if (event.type !== 'message.user') return; // takeover/resume/human echoes — no-op

  const convId = event.janis_conversation_id;
  if (!convId) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv || conv.state !== 'active') return; // human owns it — don't answer

  const externalId = conv.externalId;
  const emit = (e: Parameters<typeof processEvents>[2]) => processEvents(db, agent, e);

  try {
    const llm = llmFor(agent);
    const history = await transcriptFor(db, convId);
    const { text: reply, promptTokens, completionTokens } = await complete(
      llm,
      systemPrompt(agent),
      history,
    );
    if (promptTokens || completionTokens) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens,
        completionTokens,
      });
    }
    if (!reply) {
      await emit([
        { type: 'handoff_request', conversation_id: externalId, reason: 'no LLM configured or empty reply' },
      ]);
      return;
    }
    if (reply.includes('[HANDOFF]')) {
      await emit([
        { type: 'handoff_request', conversation_id: externalId, reason: 'agent signalled handoff' },
      ]);
      return;
    }
    await emit([
      { type: 'message_out', conversation_id: externalId, text: reply, payload: { via: 'hosted' } },
    ]);
  } catch (err) {
    await emit([
      { type: 'failure', conversation_id: externalId, reason: err instanceof Error ? err.message : 'generation failed' },
      { type: 'handoff_request', conversation_id: externalId, reason: 'agent error — needs a human' },
    ]);
  }
}
