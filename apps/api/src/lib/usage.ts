import type { Db } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import { currentPeriod, llmCostMicros } from './billing.js';

/** Meter one LLM call. Never throws — billing must not break the agent loop. */
export async function recordLlmUsage(
  db: Db,
  args: {
    workspaceId: string;
    agentId?: string | null;
    conversationId?: string | null;
    model?: string | null;
    promptTokens: number;
    completionTokens: number;
  },
): Promise<void> {
  try {
    await db.insert(usageEvents).values({
      workspaceId: args.workspaceId,
      agentId: args.agentId ?? null,
      conversationId: args.conversationId ?? null,
      kind: 'llm_tokens',
      model: args.model ?? null,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      costMicros: llmCostMicros(args.model, args.promptTokens, args.completionTokens),
      period: currentPeriod(),
    });
  } catch {
    // metering failure is never worth breaking a conversation
  }
}
