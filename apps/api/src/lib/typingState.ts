/**
 * Ephemeral "operator is typing" state — in-memory only, ~6s TTL refreshed
 * by throttled composer pings. The public widget has no SSE subscription, so
 * the /chat poll endpoint reads this and renders dots visitor-side. A stale
 * entry simply expires — no cleanup path is needed.
 */
const TTL_MS = 6_000;
const typing = new Map<string, { name: string | null; expires: number }>();

export function markOperatorTyping(conversationId: string, name: string | null): void {
  typing.set(conversationId, { name, expires: Date.now() + TTL_MS });
}

export function operatorTyping(conversationId: string): { name: string | null } | null {
  const t = typing.get(conversationId);
  if (!t) return null;
  if (t.expires < Date.now()) {
    typing.delete(conversationId);
    return null;
  }
  return { name: t.name };
}

/** The operator's reply just stored — they can't still be composing it. */
export function clearOperatorTyping(conversationId: string): void {
  typing.delete(conversationId);
}

/**
 * "Agent is working" — set when a message.user is dispatched to the agent
 * (hosted or external webhook), cleared in ingest when its reply lands.
 * Longer TTL than typing pings: LLM + tool-call runs are measured in tens of
 * seconds; the expiry is only the safety net for an agent that never replies.
 */
const AGENT_TTL_MS = 90_000;
const working = new Map<string, number>();

export function markAgentWorking(conversationId: string): void {
  working.set(conversationId, Date.now() + AGENT_TTL_MS);
}

export function clearAgentWorking(conversationId: string): void {
  working.delete(conversationId);
}

export function agentWorking(conversationId: string): boolean {
  const expires = working.get(conversationId);
  if (!expires) return false;
  if (expires < Date.now()) {
    working.delete(conversationId);
    return false;
  }
  return true;
}
