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
  opts: {
    /** Attribute the line to an operator — used for takeover/resume-style
     *  notes so the who-label shows a name, not the agent. */
    authorId?: string | null;
    /** 'human' shows the operator as sender; 'out' (default) shows Janis. */
    direction?: 'out' | 'human';
  } = {},
): Promise<void> {
  const [note] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: opts.direction ?? 'out',
      authorId: opts.authorId ?? null,
      text,
      payload: { internal: true, event },
    })
    .returning();
  bus.publish(workspaceId, { type: 'message', data: toMessage(note) });
}

/**
 * Transcript lines for rule-driven routing — the one implementation shared by
 * ingest, fireRuleAlert, and the sweeper so every path logs the same shape:
 * applied assigns, refused assigns ("already owned"), and added tags.
 * `conv` is the PRE-update row — routing is non-stealing, so an assigneeId
 * that didn't stick shows up as the refusal line.
 */
export async function noteRuleRouting(
  db: Db,
  workspaceId: string,
  conv: { id: string; assigneeId: string | null; tags: string[] },
  routing: { assigneeId?: string | null; tags?: string[] },
  ruleName: string,
): Promise<void> {
  const addedTags = (routing.tags ?? []).filter((t) => !conv.tags.includes(t));
  if (!routing.assigneeId && !addedTags.length) return;
  const names = await userNames(db, [
    ...(routing.assigneeId ? [routing.assigneeId] : []),
    ...(conv.assigneeId ? [conv.assigneeId] : []),
  ]);
  if (routing.assigneeId) {
    const target = names.get(routing.assigneeId) ?? 'a teammate';
    if (!conv.assigneeId) {
      await systemNote(db, workspaceId, conv.id,
        `Assigned to ${target} (${ruleName})`, 'assign');
    } else {
      const owner = names.get(conv.assigneeId) ?? 'a teammate';
      await systemNote(db, workspaceId, conv.id,
        `${ruleName} tried to assign ${target} — already owned by ${owner}`, 'assign');
    }
  }
  for (const t of addedTags) {
    await systemNote(db, workspaceId, conv.id, `Tagged "${t}" (${ruleName})`, 'tag');
  }
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
