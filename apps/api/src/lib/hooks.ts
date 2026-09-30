import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, hookSubscriptions } from '../db/schema.js';
import { toConversation } from './serializers.js';

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
 * Fire-and-forget fan-out to every subscription matching (agent, event).
 * The payload is the same serialized conversation the polling trigger
 * returns, so field mapping is identical whether the Zap polls or a hook
 * pushes. A slow or dead target never delays the conversation pipeline.
 */
export function emitHookEvent(
  db: Db,
  agentId: string,
  event: HookEvent,
  conv: ConversationRow,
): void {
  void (async () => {
    const subs = await db
      .select()
      .from(hookSubscriptions)
      .where(and(eq(hookSubscriptions.agentId, agentId), eq(hookSubscriptions.event, event)));
    if (!subs.length) return;
    const body = JSON.stringify(toConversation(conv));
    await Promise.allSettled(
      subs.map((s) =>
        fetch(s.targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(8_000),
        }),
      ),
    );
  })().catch(() => {});
}
