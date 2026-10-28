import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, hookSubscriptions } from '../db/schema.js';
import { toConversation } from './serializers.js';
import { deliverHookPush } from './webhooks.js';

/** Events subscribers can register for via POST /v1/hooks. Names match the
 *  Zapier trigger keys so REST-hook pushes carry the same semantics. */
export const HOOK_EVENTS = [
  'new_conversation',
  'conversation_escalated',
  'conversation_resolved',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

type ConversationRow = typeof conversations.$inferSelect;

/**
 * Fan-out to every subscription matching (agent, event) — one durable
 * webhook_deliveries row each, pushed on the same retry/sweeper/replay
 * machinery as agent webhooks. The payload is the same serialized
 * conversation the polling trigger returns, so field mapping is identical
 * whether the Zap polls or a hook pushes. Fire-and-forget: the pipeline
 * awaits nothing, but the delivery rows persist, so a slow or dead target
 * is retried and visible instead of silently dropped. Returns the enqueue
 * promise so tests can await it; production callers ignore it.
 */
export function emitHookEvent(
  db: Db,
  agentId: string,
  event: HookEvent,
  conv: ConversationRow,
): Promise<void> {
  return (async () => {
    const subs = await db
      .select()
      .from(hookSubscriptions)
      .where(and(eq(hookSubscriptions.agentId, agentId), eq(hookSubscriptions.event, event)));
    if (!subs.length) return;
    const payload = toConversation(conv);
    const results = await Promise.allSettled(
      subs.map((s) => deliverHookPush(db, agentId, s.targetUrl, `hook:${event}`, payload)),
    );
    for (const [i, r] of results.entries())
      if (r.status === 'rejected')
        console.error(
          `hook enqueue failed: ${event} agent=${agentId} conv=${conv.id} sub=${subs[i].id}`,
          r.reason,
        );
  })().catch((err) => console.error('hook emit failed:', err));
}
