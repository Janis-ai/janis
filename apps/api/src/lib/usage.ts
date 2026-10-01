import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usageEvents, workspaces } from '../db/schema.js';
import { billingConfig, currentPeriod, llmCostMicros, pricedRateFor } from './billing.js';
import {
  METER_LLM_MICROS,
  METER_STT_MICROS,
  METER_VOICE_MICROS,
  billingCustomerFor,
  reportMeter,
} from './stripe.js';
import { env } from '../env.js';

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
      reportMeter(await billingCustomerFor(db, args.workspaceId), METER_LLM_MICROS, billed, row?.id);
    }
  } catch {
    // metering failure is never worth breaking a conversation
  }
}

/**
 * AI-spend circuit breaker — rolling 24h sum of Janis-keyed LLM cost for the
 * workspace. BYOK rows record costMicros=0, so customer-key agents never trip
 * it. Returns the running total (micro-USD) when at/over LLM_DAILY_CAP_MICROS;
 * callers skip the LLM call and escalate to a human instead — protects both
 * the customer's metered bill and Janis's provider key. 0 disables.
 */
export async function llmSpendOverCap(db: Db, workspaceId: string): Promise<number | null> {
  const cap = env.llmDailyCapMicros;
  if (!cap) return null;
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.workspaceId, workspaceId),
        eq(usageEvents.kind, 'llm_tokens'),
        gt(usageEvents.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  const total = Number(row?.total ?? 0);
  return total >= cap ? total : null;
}

/**
 * Meter one hosted voice call. The Twilio status webhook carries CallDuration
 * on terminal statuses; retries are deduped on external_id so a call bills
 * once. Hosted numbers only — BYO-Twilio channels bill on the customer's own
 * account and never reach this (callers check creds.hosted).
 */
export async function recordVoiceUsage(
  db: Db,
  args: {
    workspaceId: string;
    agentId?: string | null;
    conversationId?: string | null;
    seconds: number;
    callSid: string;
  },
): Promise<void> {
  try {
    if (args.seconds <= 0) return;
    const externalId = `voice:${args.callSid}`;
    const existing = await db
      .select({ id: usageEvents.id })
      .from(usageEvents)
      .where(and(eq(usageEvents.externalId, externalId), eq(usageEvents.kind, 'voice_seconds')))
      .limit(1);
    if (existing.length) return;
    const costMicros = Math.round((env.voiceCostMicrosPerMin / 60) * args.seconds);
    const [row] = await db
      .insert(usageEvents)
      .values({
        workspaceId: args.workspaceId,
        agentId: args.agentId ?? null,
        conversationId: args.conversationId ?? null,
        kind: 'voice_seconds',
        externalId,
        quantity: args.seconds,
        costMicros,
        period: currentPeriod(),
      })
      .returning({ id: usageEvents.id });
    const billed = Math.ceil(costMicros * (1 + billingConfig.margin));
    if (billed > 0) {
      reportMeter(await billingCustomerFor(db, args.workspaceId), METER_VOICE_MICROS, billed, row?.id);
    }
  } catch {
    // metering failure is never worth breaking a call
  }
}

/**
 * Meter one dictation transcription. Always platform-keyed — dictation runs
 * on JANIS_LLM / OPENAI creds regardless of the agent's LLM config, so BYOK
 * workspaces are billed too (that's why the widget toggle is opt-in).
 * Cost is fixed-rate ($0.003/min → 50µ/s), margin applied on report.
 */
export async function recordSttUsage(
  db: Db,
  args: { workspaceId: string; agentId?: string | null; seconds: number },
): Promise<void> {
  try {
    if (args.seconds <= 0) return;
    const [row] = await db
      .insert(usageEvents)
      .values({
        workspaceId: args.workspaceId,
        agentId: args.agentId ?? null,
        kind: 'stt_seconds',
        quantity: Math.ceil(args.seconds),
        costMicros: Math.ceil(args.seconds * 50),
        period: currentPeriod(),
      })
      .returning({ id: usageEvents.id });
    const billed = Math.ceil(row ? Math.ceil(args.seconds * 50) * (1 + billingConfig.margin) : 0);
    if (billed > 0) {
      reportMeter(await billingCustomerFor(db, args.workspaceId), METER_STT_MICROS, billed, row?.id);
    }
  } catch {
    // metering failure is never worth breaking dictation
  }
}
