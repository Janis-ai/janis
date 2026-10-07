/** Test-chat visitor persistence — the test dock's conversation is keyed
 *  by visitor id (cust_<id>), not conversation id. The builder and the
 *  dock's fallback panel share "which test conversation is current" per
 *  agent through this localStorage slot, so navigating between surfaces
 *  keeps the same thread instead of silently resolving a different one. */

export const testVisitorKey = (agentId: string) => `janis.test-visitor.${agentId}`;

export function readTestVisitor(agentId: string): string | null {
  try {
    return localStorage.getItem(testVisitorKey(agentId));
  } catch {
    return null;
  }
}

export function storeTestVisitor(agentId: string, visitor: string) {
  try {
    localStorage.setItem(testVisitorKey(agentId), visitor);
  } catch {
    /* private mode — the override still applies for this mount */
  }
}

/** A fresh test-customer id — AskJanis prepends 'cust_' itself. */
export function freshTestVisitor(): string {
  return (
    crypto.randomUUID?.() ??
    `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
  ).replace(/-/g, '');
}

/** Test conversations are externalId-keyed as <kind>:test:<channelId>:<custVisitor>
 *  — the visitor id is the trailing segment. */
export function testConvVisitor(externalId: string): string | null {
  const parts = externalId.split(':');
  if (parts[1] !== 'test' || parts.length < 4) return null;
  return parts.slice(3).join(':');
}

/** The raw override AskJanis expects — strips the wire-level cust_ prefix. */
export function rawVisitor(wireVisitor: string): string {
  return wireVisitor.startsWith('cust_') ? wireVisitor.slice(5) : wireVisitor;
}
