import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { typingState } from '../db/schema.js';

/**
 * Ephemeral "operator is typing" / "agent is working" state — Postgres-backed
 * (typing_state table) so the widget's /chat poll sees it regardless of which
 * instance served the composer ping under --max-instances N. Was in-memory;
 * a poll hitting a different instance than the ping silently dropped the
 * indicator. Rows self-expire on read via expires_at — no cleanup needed.
 */
const TTL_MS = 6_000;

export async function markOperatorTyping(
  db: Db,
  conversationId: string,
  name: string | null,
): Promise<void> {
  await db
    .insert(typingState)
    .values({
      conversationId,
      kind: 'operator',
      name,
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .onConflictDoUpdate({
      target: [typingState.conversationId, typingState.kind],
      set: { name, expiresAt: new Date(Date.now() + TTL_MS) },
    });
}

export async function operatorTyping(
  db: Db,
  conversationId: string,
): Promise<{ name: string | null } | null> {
  const [t] = await db
    .select({ name: typingState.name })
    .from(typingState)
    .where(
      and(
        eq(typingState.conversationId, conversationId),
        eq(typingState.kind, 'operator'),
        gt(typingState.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return t ?? null;
}

/** The operator's reply just stored — they can't still be composing it. */
export async function clearOperatorTyping(db: Db, conversationId: string): Promise<void> {
  await db
    .delete(typingState)
    .where(
      and(
        eq(typingState.conversationId, conversationId),
        eq(typingState.kind, 'operator'),
      ),
    );
  relayed.delete(conversationId); // next composing burst relays immediately
}

/**
 * Composer pings arrive far more often than Meta needs them (its typing
 * bubble persists ~20s) — relay at most one sender_action per window.
 * Instance-local on purpose: at worst two instances each relay one
 * sender_action inside a window — a duplicate typing bubble, cosmetic only.
 */
const relayed = new Map<string, number>();

export function shouldRelayTyping(conversationId: string, windowMs = 8_000): boolean {
  const last = relayed.get(conversationId);
  if (last && Date.now() - last < windowMs) return false;
  relayed.set(conversationId, Date.now());
  return true;
}

/**
 * "Agent is working" — set when a message.user is dispatched to the agent
 * (hosted or external webhook), cleared in ingest when its reply lands.
 * Longer TTL than typing pings: LLM + tool-call runs are measured in tens of
 * seconds; the expiry is only the safety net for an agent that never replies.
 */
const AGENT_TTL_MS = 90_000;

export async function markAgentWorking(db: Db, conversationId: string): Promise<void> {
  await db
    .insert(typingState)
    .values({
      conversationId,
      kind: 'agent',
      expiresAt: new Date(Date.now() + AGENT_TTL_MS),
    })
    .onConflictDoUpdate({
      target: [typingState.conversationId, typingState.kind],
      set: { expiresAt: new Date(Date.now() + AGENT_TTL_MS) },
    });
}

export async function clearAgentWorking(db: Db, conversationId: string): Promise<void> {
  await db
    .delete(typingState)
    .where(
      and(eq(typingState.conversationId, conversationId), eq(typingState.kind, 'agent')),
    );
}

export async function agentWorking(db: Db, conversationId: string): Promise<boolean> {
  const [t] = await db
    .select({ conversationId: typingState.conversationId })
    .from(typingState)
    .where(
      and(
        eq(typingState.conversationId, conversationId),
        eq(typingState.kind, 'agent'),
        gt(typingState.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(t);
}
