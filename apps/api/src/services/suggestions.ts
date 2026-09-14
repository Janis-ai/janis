import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages, suggestions } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { toSuggestion } from '../lib/serializers.js';
import { env } from '../env.js';
import type { users } from '../db/schema.js';
import { TakeoverError } from './takeover.js';

type UserRow = typeof users.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ConvRow = typeof conversations.$inferSelect;

/**
 * Ask for a suggested reply. If the agent has a webhook configured we send it
 * `suggestion.request` — the agent knows its own model and context, and POSTs
 * the result to /v1/suggestions. Otherwise fall back to a Janis-side LLM call
 * when JANIS_LLM_API_KEY is set.
 */
export async function requestSuggestion(
  db: Db,
  conv: ConvRow,
  agent: AgentRow,
): Promise<{ mode: 'agent' } | { mode: 'llm'; suggestion: typeof suggestions.$inferSelect }> {
  if (agent.webhookUrl) {
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

  const text = await generateWithLlm(db, conv);
  if (!text) {
    throw new TakeoverError(
      'no suggestion source — set the agent webhook_url or JANIS_LLM_API_KEY',
      400,
    );
  }
  const [row] = await db
    .insert(suggestions)
    .values({ conversationId: conv.id, text, source: 'llm' })
    .returning();
  return { mode: 'llm', suggestion: row };
}

/** Agent callback or internal path: store a suggestion + stream it live. */
export async function storeSuggestion(
  db: Db,
  conversationId: string,
  text: string,
  source: 'agent' | 'llm',
) {
  const [row] = await db
    .insert(suggestions)
    .values({ conversationId, text, source })
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

async function generateWithLlm(db: Db, conv: ConvRow): Promise<string | null> {
  if (!env.llmApiKey) return null;
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

  try {
    const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.llmApiKey}`,
      },
      body: JSON.stringify({
        model: env.llmModel,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              'You draft short, helpful support replies for a human operator overseeing an AI agent. Return only the reply text — no preamble, no quotes.',
          },
          { role: 'user', content: `Conversation so far:\n\n${transcript}\n\nDraft the next reply:` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}
