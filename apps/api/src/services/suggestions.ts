import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, suggestions } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { toSuggestion } from '../lib/serializers.js';
import { recordLlmUsage } from '../lib/usage.js';
import { llmFor, type LlmSettings } from '../lib/llm.js';
import type { users } from '../db/schema.js';
import { TakeoverError } from './takeover.js';

type UserRow = typeof users.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ConvRow = typeof conversations.$inferSelect;

/**
 * Ask for a suggested reply. If the agent has a webhook configured we send it
 * `suggestion.request` — the agent knows its own model and context, and POSTs
 * the result to /v1/suggestions. Otherwise fall back to the agent's LLM
 * settings (its own key when BYOK, else the platform key).
 */
export async function requestSuggestion(
  db: Db,
  conv: ConvRow,
  agent: AgentRow,
): Promise<{ mode: 'agent' } | { mode: 'llm'; suggestion: typeof suggestions.$inferSelect }> {
  if (agent.webhookUrl || agent.hosted) {
    const recent = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(20);
    await deliverWebhook(db, agent, 'suggestion.request', {
      conversation_id: conv.externalId,
      janis_conversation_id: conv.id,
      payload: {
        transcript: recent.reverse().map((m) => ({ direction: m.direction, text: m.text })),
      },
    });
    return { mode: 'agent' };
  }

  const llm = await llmFor(db, agent);
  const result = await generateWithLlm(db, conv, agent, llm);
  if (result) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      conversationId: conv.id,
      model: llm.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      byok: llm.byok,
    });
  }
  const text = result?.text;
  if (!text) {
    throw new TakeoverError(
      'no suggestion source — set the agent webhook_url or configure an LLM',
      400,
    );
  }
  const [row] = await db
    .insert(suggestions)
    .values({ conversationId: conv.id, text, notes: result?.notes ?? null, source: 'llm' })
    .returning();
  return { mode: 'llm', suggestion: row };
}

/** Agent callback or internal path: store a suggestion + stream it live. */
export async function storeSuggestion(
  db: Db,
  conversationId: string,
  text: string,
  source: 'agent' | 'llm',
  notes?: string,
) {
  const [row] = await db
    .insert(suggestions)
    .values({ conversationId, text, notes: notes ?? null, source })
    .returning();
  const [conv] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conv) {
    bus.publish(conv.workspaceId, { type: 'suggestion', data: toSuggestion(row) });
  }
  return row;
}

async function generateWithLlm(
  db: Db,
  conv: ConvRow,
  agent: AgentRow,
  llm: LlmSettings,
): Promise<{ text: string; notes: string | null; promptTokens: number; completionTokens: number } | null> {
  if (!llm.apiKey) return null;
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  const transcript = recent
    .reverse()
    .map((m) => `${m.direction === 'in' ? 'User' : m.direction === 'human' ? 'Human operator' : 'Agent'}: ${m.text ?? ''}`)
    .join('\n');

  // Feed the agent's own persona/goals into the draft so the suggestion steers
  // toward the outcome this agent exists to produce, not just "a next line".
  const cfg = (agent.config ?? {}) as { system_prompt?: string; tone?: string };
  const persona = [cfg.system_prompt, cfg.tone ? `Tone: ${cfg.tone}` : '']
    .filter(Boolean)
    .join('\n')
    .trim();
  const system = [
    'You draft replies for a human operator who has taken over a customer conversation from an AI agent.',
    persona && `The agent's own instructions and goals (stay in character):\n<agent_prompt>\n${persona.slice(0, 2000)}\n</agent_prompt>`,
    'Figure out what outcome the agent is trying to reach, what the customer still needs or must provide to get there, and write the single reply that best moves the conversation toward resolution. If information is missing, ask for it; if the customer is stuck, unblock them.',
    'Respond with JSON only: {"notes": "one short sentence — what this reply achieves or what is still needed", "reply": "the reply text to send"}. The reply goes to the customer verbatim: short, in the agent\'s voice, no preamble.',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
        ...(llm.headers ?? {}),
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Conversation so far:\n\n${transcript}\n\nDraft the reply that moves this toward resolution:` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    // response_format is best-effort on some providers — fall back to the raw
    // text when the payload isn't the {"notes","reply"} object we asked for
    let text = raw;
    let notes: string | null = null;
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { notes?: unknown; reply?: unknown };
        if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
          text = parsed.reply.trim();
          if (typeof parsed.notes === 'string') notes = parsed.notes.trim() || null;
        }
      } catch {
        /* keep raw as the reply */
      }
    }
    if (!text) return null;
    // estimate chars/4 when the endpoint omits `usage` rather than billing zero
    return {
      text,
      notes,
      promptTokens: json.usage?.prompt_tokens ?? Math.ceil(transcript.length / 4),
      completionTokens: json.usage?.completion_tokens ?? Math.ceil(raw.length / 4),
    };
  } catch {
    return null;
  }
}
