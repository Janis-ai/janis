import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations } from '../db/schema.js';
import { bus } from './bus.js';
import { resolveOpenAlerts } from './alerts.js';
import { sendCsatPrompt } from './csat.js';
import { channelBindingFor, releaseThreadControl } from './channels.js';
import { emitHookEvent } from './hooks.js';
import { STATE_LABEL, systemNote, userNames } from './systemNote.js';

type ConvRow = typeof conversations.$inferSelect;
type Actor = { id: string; name: string } | null;

/**
 * A mechanical state transition — update + bus + audit line + hooks. This is
 * THE way a conversation changes state outside the operator PATCH path (which
 * folds state into a bigger update and runs applyConvEffects after). Every
 * needs_human escalation MUST come through here so the conversation_escalated
 * webhook and the transcript line can't drift out of one of the call sites.
 */
export async function transitionConversation(
  db: Db,
  workspaceId: string,
  conv: ConvRow,
  to: ConvRow['state'],
  opts: {
    cause?: string;
    set?: Partial<typeof conversations.$inferInsert>;
    actor?: Actor;
  } = {},
): Promise<ConvRow> {
  const [updated] = await db
    .update(conversations)
    .set({ state: to, ...opts.set })
    .where(eq(conversations.id, conv.id))
    .returning();
  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: conv.id, state: to },
  });
  if (to !== conv.state) {
    await systemNote(
      db,
      workspaceId,
      conv.id,
      opts.actor
        ? `${opts.actor.name} set status to ${STATE_LABEL[to] ?? to}${opts.cause ? ` — ${opts.cause}` : ''}`
        : `Status: ${STATE_LABEL[conv.state] ?? conv.state} → ${STATE_LABEL[to] ?? to}${opts.cause ? ` — ${opts.cause}` : ''}`,
      'state_change',
    );
    if (to === 'needs_human') emitHookEvent(db, conv.agentId, 'conversation_escalated', updated);
    if (to === 'archived') emitHookEvent(db, conv.agentId, 'conversation_resolved', updated);
  }
  return updated;
}

/**
 * Post-update side effects for an operator (or API) driven change — call
 * with the before/after rows and which fields were requested. Centralizes
 * the semantics that used to live in PATCH and /bulk separately: state
 * transitions get an audit line + hooks + CSAT on archive + Meta thread
 * release leaving 'human' + the open-alert sweep on 'active' AND 'archived'
 * (a resolved thread means its alerts are handled too); assignee/tag/intent
 * diffs get attributed notes.
 */
export async function applyConvEffects(
  db: Db,
  workspaceId: string,
  before: Pick<ConvRow, 'id' | 'agentId' | 'state' | 'assigneeId' | 'tags' | 'intent'>,
  after: ConvRow,
  requested: {
    state?: ConvRow['state'];
    assigneeId?: string | null;
    tags?: string[];
    intent?: string | null;
  },
  actor: Actor,
): Promise<void> {
  bus.publish(workspaceId, {
    type: 'conversation',
    data: { id: after.id, state: after.state },
  });

  if (requested.state !== undefined && after.state !== before.state) {
    await systemNote(
      db,
      workspaceId,
      after.id,
      actor
        ? `${actor.name} set status to ${STATE_LABEL[after.state] ?? after.state}`
        : `Status: ${STATE_LABEL[before.state] ?? before.state} → ${STATE_LABEL[after.state] ?? after.state}`,
      'state_change',
    );
    if (after.state === 'needs_human')
      emitHookEvent(db, after.agentId, 'conversation_escalated', after);
    if (after.state === 'archived') {
      emitHookEvent(db, after.agentId, 'conversation_resolved', after);
      await sendCsatPrompt(db, after).catch(() => {});
    }
    // Leaving human mode hands a Meta thread back to the channel's receiver.
    if (before.state === 'human') {
      void (async () => {
        const b = await channelBindingFor(db, after.id);
        if (b) await releaseThreadControl(b.channel, b.platformUserId);
      })();
    }
  }

  // "Back to the agent" sweeps open alerts even when the state didn't
  // change — a keyword alert on an already-active conv is still cleared by
  // the operator choosing Active. Archiving sweeps only on the transition.
  if (
    requested.state === 'active' ||
    (requested.state === 'archived' && after.state !== before.state)
  ) {
    const resolved = await resolveOpenAlerts(db, workspaceId, after.id);
    if (resolved.length && actor) {
      await systemNote(
        db,
        workspaceId,
        after.id,
        `${actor.name} resolved ${resolved.length} open alert${resolved.length === 1 ? '' : 's'}`,
        'alert_status',
      );
    }
  }

  if (requested.assigneeId !== undefined && after.assigneeId !== before.assigneeId) {
    const names = await userNames(db, [
      ...(after.assigneeId ? [after.assigneeId] : []),
      ...(before.assigneeId ? [before.assigneeId] : []),
    ]);
    const me = actor?.name ?? 'The API';
    if (after.assigneeId === actor?.id) {
      await systemNote(db, workspaceId, after.id, `${me} assigned themselves`, 'assign');
    } else if (after.assigneeId) {
      await systemNote(db, workspaceId, after.id,
        `${me} assigned the conversation to ${names.get(after.assigneeId) ?? 'a teammate'}`, 'assign');
    } else {
      const prev =
        before.assigneeId === actor?.id
          ? 'themselves'
          : names.get(before.assigneeId ?? '') ?? 'a teammate';
      await systemNote(db, workspaceId, after.id, `${me} unassigned ${prev}`, 'assign');
    }
  }

  if (requested.intent !== undefined && after.intent !== before.intent) {
    const me = actor?.name ?? 'The API';
    await systemNote(
      db,
      workspaceId,
      after.id,
      after.intent
        ? `${me} set the topic to "${after.intent}"`
        : `${me} cleared the topic`,
      'intent',
    );
  }

  if (requested.tags !== undefined) {
    const me = actor?.name ?? 'The API';
    const beforeTags = before.tags ?? [];
    const afterTags = after.tags ?? [];
    for (const t of afterTags.filter((t) => !beforeTags.includes(t))) {
      await systemNote(db, workspaceId, after.id, `${me} tagged "${t}"`, 'tag');
    }
    for (const t of beforeTags.filter((t) => !afterTags.includes(t))) {
      await systemNote(db, workspaceId, after.id, `${me} removed the tag "${t}"`, 'tag');
    }
  }
}
