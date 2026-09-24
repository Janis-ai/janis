import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usageEvents, workspaces } from '../db/schema.js';
import { billingConfig, currentPeriod, llmCostMicros } from './billing.js';
import { METER_LLM_MICROS, reportMeter } from './stripe.js';

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
    /** Call ran on the customer's own LLM key/endpoint — tokens are recorded
     *  for visibility, but there is no Janis-side cost to bill. */
    byok?: boolean;
  },
): Promise<void> {
  try {
    const costMicros = args.byok
      ? 0
      : llmCostMicros(args.model, args.promptTokens, args.completionTokens);
    await db.insert(usageEvents).values({
      workspaceId: args.workspaceId,
      agentId: args.agentId ?? null,
      conversationId: args.conversationId ?? null,
      kind: 'llm_tokens',
      model: args.model ?? null,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      costMicros,
      period: currentPeriod(),
    });
    // Stripe metered billing — report billed micro-USD (cost + margin)
    const billed = Math.ceil(costMicros * (1 + billingConfig.margin));
    if (billed > 0) {
      const [ws] = await db
        .select({ stripeCustomerId: workspaces.stripeCustomerId })
        .from(workspaces)
        .where(eq(workspaces.id, args.workspaceId))
        .limit(1);
      reportMeter(ws?.stripeCustomerId, METER_LLM_MICROS, billed);
    }
  } catch {
    // metering failure is never worth breaking a conversation
  }
}
