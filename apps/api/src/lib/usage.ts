import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usageEvents, workspaces } from '../db/schema.js';
import { billingConfig, currentPeriod, llmCostMicros, pricedRateFor } from './billing.js';
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
    /** The model the customer actually configured — fallback failover can
     *  land on a pricier model (flash-lite → flash) and the customer never
     *  picked it, so billed cost caps at their model's rate. A cheaper
     *  fallback simply bills less. */
    capModel?: string | null;
  },
): Promise<void> {
  try {
    const served = llmCostMicros(args.model, args.promptTokens, args.completionTokens);
    const costMicros = args.byok
      ? 0
      : Math.min(
          served,
          args.capModel
            ? llmCostMicros(args.capModel, args.promptTokens, args.completionTokens)
            : Infinity,
        );
    // metered call on an unpriced model slipped past the llmFor guard
    // (e.g. JANIS_LLM_FALLBACK_MODEL) — billing at the default rate
    if (!args.byok && !pricedRateFor(args.model)) {
      console.warn(`llm usage billed at default rate — no price for '${args.model}'`);
    }
    const [row] = await db
      .insert(usageEvents)
      .values({
        workspaceId: args.workspaceId,
        agentId: args.agentId ?? null,
        conversationId: args.conversationId ?? null,
        kind: 'llm_tokens',
        model: args.model ?? null,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costMicros,
        period: currentPeriod(),
      })
      .returning({ id: usageEvents.id });
    // Stripe metered billing — report billed micro-USD (cost + margin).
    // The event identifier dedupes retries and lets us cancel a mispriced
    // event via meter event adjustments instead of a credit note.
    const billed = Math.ceil(costMicros * (1 + billingConfig.margin));
    if (billed > 0) {
      const [ws] = await db
        .select({ stripeCustomerId: workspaces.stripeCustomerId })
        .from(workspaces)
        .where(eq(workspaces.id, args.workspaceId))
        .limit(1);
      reportMeter(ws?.stripeCustomerId, METER_LLM_MICROS, billed, row?.id);
    }
  } catch {
    // metering failure is never worth breaking a conversation
  }
}
