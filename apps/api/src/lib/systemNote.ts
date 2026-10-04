import type { AlertType } from '@janis/shared';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages, users } from '../db/schema.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';

/** Conversation state → operator-facing word for transcript status lines. */
export const STATE_LABEL: Record<string, string> = {
  active: 'agent',
  needs_human: 'needs human',
  human: 'human takeover',
  archived: 'archived',
};

/** Alert type → short human label for transcript notes. */
export const ALERT_LABEL: Record<AlertType, string> = {
  failure: 'Agent failure',
  help_request: 'Handoff requested',
  handoff_offer: 'Agent offered a human',
  custom: 'Custom alert',
  sla: 'SLA breach',
  inactivity: 'Inactivity',
  keyword: 'Keyword match',
  approval_request: 'Approval requested',
  sentiment: 'Negative sentiment',
  intent: 'Topic match',
  error: 'Run error',
  csat: 'Low CSAT',
};

/**
 * An internal status line in the transcript — renders as a system message in
 * the console (payload.internal), never delivered to channels, and does NOT
 * touch the conversation's lastMessage* fields: bumping those would fake an
 * agent reply and defeat inactivity detection / unread semantics.
 */
export async function systemNote(
  db: Db,
  workspaceId: string,
  conversationId: string,
  text: string,
  event: string,
): Promise<void> {
  const [note] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'out',
      text,
      payload: { internal: true, event },
    })
    .returning();
  bus.publish(workspaceId, { type: 'message', data: toMessage(note) });
}

/** id → display name for attribution lines; ids missing from the map should
 *  fall back to a generic phrase at the call site. */
export async function userNames(
  db: Db,
  ids: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name ?? 'a teammate']));
}
