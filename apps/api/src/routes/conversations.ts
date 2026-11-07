import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  agentWidgets,
  alerts,
  channelBindings,
  conversations,
  convTombstones,
  memberships,
  messages,
  pendingActions,
  slackThreads,
  suggestions,
  usageEvents,
  users,
  workspaces,
} from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toAlert, toConversation, toMessage, toSuggestion } from '../lib/serializers.js';
import { applyConvEffects } from '../lib/conversationOps.js';
import { convListConditions, convListQuery, MERCHANT_CONV, TEST_CONV } from '../lib/convFilters.js';
import { agentRoleFor, agentVis, conversationAgent, isAdminRole, operatorIdentity } from '../lib/access.js';
import { bus } from '../lib/bus.js';
import {
  agentSend,
  getConversationForWorkspace,
  humanReply,
  internalNote,
  resume,
  takeover,
  TakeoverError,
  teachAgent,
} from '../services/takeover.js';
import { requestSuggestion } from '../services/suggestions.js';
import { operatorBrief, resolveWidgetRef } from '../lib/hostedAgent.js';
import { decidePendingAction, requestToolApproval } from '../lib/approvals.js';
import { toolsFor, type ToolDef } from '../lib/toolExec.js';
import { WidgetComponent } from '../lib/widgets.js';
import { loadSecretsMap } from '../lib/secrets.js';
import { connectionSecrets } from '../lib/connections.js';
import { QuickReply } from '@janis/shared';
import { fetchAvatar } from '../lib/avatar.js';
import { markOperatorTyping, shouldRelayTyping } from '../lib/typingState.js';
import { markViewing } from '../lib/presence.js';
import {
  channelBindingFor,
  deliverToChannel,
  sendChannelTyping,
  takeThreadControl,
  type AttachmentRef,
  type SendOptions,
} from '../lib/channels.js';

const listQuery = convListQuery;

/** Working a paused conversation — asking for a draft, deciding an
 *  action, staging a component — IS operator activity. Only actual
 *  sends reset humanSince today, so the auto-resume window could lapse
 *  mid-draft and the agent replied while the operator was still
 *  composing. Any engagement endpoint resets the clock + the warning,
 *  so silence (not activity) is what resumes the agent. */
async function touchTakeover(db: Db, conversationId: string) {
  await db
    .update(conversations)
    .set({ humanSince: new Date(), resumeWarnedAt: null })
    .where(and(eq(conversations.id, conversationId), eq(conversations.state, 'human')));
}

/** Follow merge tombstones — a conversation id deleted by visitor adoption
 *  resolves to the surviving conversation, so links minted pre-merge
 *  (alert emails, bookmarks) keep working. Bounded chain for A→B→C merges. */
async function resolveConvId(db: Db, id: string): Promise<string> {
  let cur = id;
  for (let i = 0; i < 3; i++) {
    const [t] = await db
      .select({ into: convTombstones.mergedIntoId })
      .from(convTombstones)
      .where(eq(convTombstones.id, cur))
      .limit(1);
    if (!t) return cur;
    cur = t.into;
  }
  return cur;
}

const patchBody = z.object({
  tags: z.array(z.string()).optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  state: z.enum(['active', 'needs_human', 'archived']).optional(),
  is_starred: z.boolean().optional(),
  is_unread: z.boolean().optional(),
  // ISO timestamp or null — snooze hides the conversation from every queue
  // until it expires or a customer reply wakes it
  snoozed_until: z.string().datetime({ offset: true }).nullable().optional(),
  // Operator intent override — stamps intent_source='manual' so the drift
  // re-check never overwrites it. null clears back to unclassified.
  intent: z.string().max(60).nullable().optional(),
});

const bulkBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum([
    'archive',
    'unarchive',
    'assign_me',
    'unassign',
    'tag',
    'untag',
    'mark_read',
    'mark_unread',
    'star',
    'unstar',
    'snooze',
    'unsnooze',
    'delete',
  ]),
  tag: z.string().trim().min(1).max(40).optional(),
  minutes: z.number().int().min(1).max(43_200).optional(), // snooze duration, ≤30d
});

const attachment = z.object({
  name: z.string(),
  url: z.string(),
  type: z.string(),
  size: z.number(),
});

const replyBody = z
  .object({
    text: z.string().default(''),
    attachments: z.array(attachment).optional(),
    // Rich components carried by a suggestion card or a manual component
    // send — delivered exactly like an agent reply (native render or the
    // per-channel mapping).
    widgets: z.array(WidgetComponent).max(8).optional(),
    quick_replies: z.array(QuickReply).max(13).optional(),
  })
  .refine(
    (d) =>
      d.text.trim().length > 0 ||
      (d.attachments?.length ?? 0) > 0 ||
      (d.widgets?.length ?? 0) > 0,
    { message: 'text, attachments or widgets required' },
  );

export function conversationRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', zValidator('query', listQuery), async (c) => {
    const workspaceId = c.get('workspaceId');
    const q = c.req.valid('query');

    const conditions = convListConditions(q, workspaceId, c.get('user').id, c.get('agentScope'));

    // Total for the Gmail-style "1–50 of N" pager — the filtered set
    // BEFORE the cursor slice narrows it.
    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(...conditions));

    // Sort key: last activity, falling back to creation for threads with no
    // messages yet. id is the tiebreaker so the order is total — the cursor
    // comparison below relies on it.
    const sortKey = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
    if (q.cursor) {
      const [ms, id] = q.cursor.split('_');
      conditions.push(
        sql`(${sortKey}, ${conversations.id}) < (${new Date(Number(ms)).toISOString()}::timestamptz, ${id}::uuid)`,
      );
    }

    const limit = q.limit ?? 200;
    const rows = await db
      .select({
        conversation: conversations,
        openAlertCount: sql<number>`(
          select count(*)::int from ${alerts}
          where ${alerts.conversationId} = ${conversations.id}
            and ${alerts.status} = 'open'
        )`,
        isTest: sql<boolean>`${TEST_CONV}`,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(sql`${sortKey} desc`, desc(conversations.id))
      .limit(limit + 1); // one extra row to tell if another page exists

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1]?.conversation;
    const nextCursor =
      hasMore && last
        ? `${(last.lastMessageAt ?? last.createdAt).getTime()}_${last.id}`
        : null;

    return c.json({
      conversations: page.map((r) => toConversation(r.conversation, r.openAlertCount, r.isTest)),
      has_more: hasMore,
      next_cursor: nextCursor,
      total,
    });
  });

  // count of conversations needing a human — powers the nav badge
  app.get('/attention-count', async (c) => {
    const workspaceId = c.get('workspaceId');
    const scope = agentVis(workspaceId, c.get('agentScope'));
    // ?agent_id= scopes the badge for the agent-context inbox
    const agentId = c.req.query('agent_id');
    // A slug/typo here would blow up the uuid cast below as a 500.
    if (agentId && !z.string().uuid().safeParse(agentId).success) {
      return c.json({ error: 'invalid agent_id' }, 400);
    }
    const agentCond = agentId ? [eq(conversations.agentId, agentId)] : [];
    const [[{ count }], [{ count: unread }], [{ count: attention }]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(
          and(
            ...scope,
            ...agentCond,
            or(
              inArray(conversations.state, ['needs_human', 'human']),
              sql`exists (
                select 1 from ${alerts}
                where ${alerts.conversationId} = ${conversations.id}
                  and ${alerts.status} = 'open'
              )`,
            ),
            // a test chat flipping needs_human is the suite working, not a
            // customer waiting — the badge must not cry wolf
            sql`not ${TEST_CONV}`,
            sql`not ${MERCHANT_CONV}`,
            // snoozed = out of sight until it wakes
            sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(
          and(
            ...scope,
            ...agentCond,
            eq(conversations.isUnread, true),
            // archived threads are out of the inbox — put away, not unseen
            ne(conversations.state, 'archived'),
            sql`not ${TEST_CONV}`,
            sql`not ${MERCHANT_CONV}`,
            sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
          ),
        ),
      // The nav badge previews "there's something to look at" — anything
      // needing a human OR carrying unseen inbound, deduped into one number.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(
          and(
            ...scope,
            ...agentCond,
            ne(conversations.state, 'archived'),
            or(
              inArray(conversations.state, ['needs_human', 'human']),
              eq(conversations.isUnread, true),
              sql`exists (
                select 1 from ${alerts}
                where ${alerts.conversationId} = ${conversations.id}
                  and ${alerts.status} = 'open'
              )`,
            ),
            sql`not ${TEST_CONV}`,
            sql`not ${MERCHANT_CONV}`,
            sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
          ),
        ),
    ]);
    return c.json({ count, unread, attention });
  });

  // Batch operations on the conversations list — same field semantics as
  // PATCH /:id, applied to every workspace-visible id in the request.
  app.post('/bulk', zValidator('json', bulkBody), async (c) => {
    const workspaceId = c.get('workspaceId');
    const user = c.get('user');
    const { ids, action, tag, minutes } = c.req.valid('json');
    if ((action === 'tag' || action === 'untag') && !tag) {
      return c.json({ error: 'tag is required' }, 400);
    }

    const rows = await db
      .select()
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(inArray(conversations.id, ids), ...agentVis(workspaceId, c.get('agentScope'))));
    if (!rows.length) return c.json({ updated: 0 });

    const now = new Date();
    const set: Partial<typeof conversations.$inferInsert> | null =
      action === 'archive' ? { state: 'archived', archivedAt: now, snoozedUntil: null }
      : action === 'unarchive' ? { state: 'active', archivedAt: null }
      : action === 'assign_me' ? { assigneeId: user.id }
      : action === 'unassign' ? { assigneeId: null }
      : action === 'mark_read' ? { isUnread: false }
      : action === 'mark_unread' ? { isUnread: true }
      : action === 'star' ? { isStarred: true }
      : action === 'unstar' ? { isStarred: false }
      : action === 'snooze' ? { snoozedUntil: new Date(now.getTime() + (minutes ?? 240) * 60_000) }
      : action === 'unsnooze' ? { snoozedUntil: null }
      : null;

    const ownedIds = rows.map((r) => r.conversations.id);
    if (action === 'delete') {
      // Same cascade as DELETE /:id — deps first, then the conversation.
      await db.delete(messages).where(inArray(messages.conversationId, ownedIds));
      await db.delete(alerts).where(inArray(alerts.conversationId, ownedIds));
      await db.delete(suggestions).where(inArray(suggestions.conversationId, ownedIds));
      await db.delete(slackThreads).where(inArray(slackThreads.conversationId, ownedIds));
      await db.delete(channelBindings).where(inArray(channelBindings.conversationId, ownedIds));
      await db
        .update(usageEvents)
        .set({ conversationId: null })
        .where(inArray(usageEvents.conversationId, ownedIds));
      await db.delete(conversations).where(inArray(conversations.id, ownedIds));
      return c.json({ updated: ownedIds.length });
    }
    if (set) {
      await db.update(conversations).set(set).where(inArray(conversations.id, ownedIds));
    } else {
      // tag/untag merge per row — array ops can't be expressed in one update
      for (const r of rows) {
        const cur = r.conversations.tags ?? [];
        const next =
          action === 'tag'
            ? [...new Set([...cur, tag!])]
            : cur.filter((t) => t !== tag);
        if (next.length !== cur.length || action === 'untag') {
          await db.update(conversations).set({ tags: next }).where(eq(conversations.id, r.conversations.id));
        }
      }
    }

    // Side effects + audit notes — one implementation shared with PATCH
    // (state transition lines, hooks, CSAT on archive, Meta thread release,
    // open-alert sweep on active/archived, attributed assign/tag notes).
    for (const r of rows) {
      const conv = r.conversations;
      const requested =
        action === 'archive' ? { state: 'archived' as const }
        : action === 'unarchive' ? { state: 'active' as const }
        : action === 'assign_me' ? { assigneeId: user.id }
        : action === 'unassign' ? { assigneeId: null as string | null }
        : action === 'tag' || action === 'untag'
          ? {
              tags:
                action === 'tag'
                  ? [...new Set([...(conv.tags ?? []), tag!])]
                  : (conv.tags ?? []).filter((t) => t !== tag),
            }
          : {};
      const after = { ...conv, ...(set ?? {}), ...(requested as object) };
      await applyConvEffects(db, workspaceId, conv, after, requested, user);
    }
    return c.json({ updated: ownedIds.length });
  });

  app.get('/:id', async (c) => {
    const workspaceId = c.get('workspaceId');
    const convId = await resolveConvId(db, c.req.param('id'));
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, convId), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);

    // Latest page first — older history back-fills via /:id/messages?before=.
    // PAGE+1 rows tells us whether an earlier page exists.
    const PAGE = 100;
    const [msgRows, convAlerts, convSuggestions] = await Promise.all([
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, row.conversation.id))
        .orderBy(desc(messages.createdAt))
        .limit(PAGE + 1),
      db
        .select()
        .from(alerts)
        .where(eq(alerts.conversationId, row.conversation.id))
        .orderBy(desc(alerts.createdAt))
        .limit(100),
      db
        .select()
        .from(suggestions)
        .where(
          and(
            eq(suggestions.conversationId, row.conversation.id),
            eq(suggestions.status, 'pending'),
          ),
        )
        .orderBy(desc(suggestions.createdAt))
        .limit(10),
    ]);

    const msgs = msgRows.slice(0, PAGE).reverse();

    // Verified Janis visitor? — the profile's external_id is their user id.
    // Surface their best workspace plan so the operator sees paying vs free.
    const visitorId = (row.conversation.userProfile as { external_id?: string } | null)
      ?.external_id;
    let memberPlan: string | undefined;
    if (visitorId) {
      const RANK: Record<string, number> = { free: 0, starter: 1, pro: 2, scale: 3, internal: 4 };
      const plans = await db
        .select({ plan: workspaces.plan })
        .from(memberships)
        .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
        .where(eq(memberships.userId, visitorId));
      memberPlan = plans
        .map((p) => p.plan ?? 'free')
        .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
    }

    // Proposed actions decide through pending_actions rows — hydrate the
    // latest decision per (tool, args) so a reload shows the outcome, not
    // reset buttons. Canonical JSON compare matches the run-action dedupe
    // without depending on key order.
    const canon = (v: unknown): string => {
      if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
      if (v && typeof v === 'object') {
        return `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
          .join(',')}}`;
      }
      return JSON.stringify(v) ?? 'null';
    };
    const proposedTools = new Set<string>();
    for (const s of convSuggestions) {
      const p = s.payload as { proposed_actions?: { name?: string }[] } | null;
      for (const a of p?.proposed_actions ?? []) if (a.name) proposedTools.add(a.name);
    }
    const actedRows = proposedTools.size
      ? await db
          .select()
          .from(pendingActions)
          .where(
            and(
              eq(pendingActions.conversationId, row.conversation.id),
              inArray(pendingActions.toolName, [...proposedTools]),
            ),
          )
          .orderBy(desc(pendingActions.createdAt))
      : [];
    const hydratedSuggestions = actedRows.length
      ? convSuggestions.map((s) => {
          const p = s.payload as
            | { proposed_actions?: { name: string; args: unknown }[] }
            | null;
          if (!p?.proposed_actions?.length) return s;
          return {
            ...s,
            payload: {
              ...p,
              proposed_actions: p.proposed_actions.map((a) => {
                const hit = actedRows.find(
                  (r) => r.toolName === a.name && canon(r.args) === canon(a.args),
                );
                return hit ? { ...a, status: hit.status, result: hit.result } : a;
              }),
            },
          };
        })
      : convSuggestions;

    return c.json({
      member_plan: memberPlan,
      conversation: toConversation(
        row.conversation,
        convAlerts.filter((a) => a.status === 'open').length,
      ),
      messages: msgs.map(toMessage),
      messages_has_more: msgRows.length > PAGE,
      alerts: convAlerts.map(toAlert),
      suggestions: hydratedSuggestions.map(toSuggestion),
      // Set when the requested id was a merge tombstone — the caller's
      // stale link resolved to this surviving conversation.
      ...(convId !== c.req.param('id') ? { merged_from: c.req.param('id') } : {}),
    });
  });

  // Older transcript pages — the initial load returns the latest page;
  // scrolling to the top fetches the next chunk with ?before=<oldest ts>.
  app.get('/:id/messages', async (c) => {
    const workspaceId = c.get('workspaceId');
    const convId = await resolveConvId(db, c.req.param('id'));
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, convId), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);

    const before = c.req.query('before');
    const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
    const PAGE = 100;

    // ?q=<text> — in-conversation search; matching rows newest-first so the
    // console can offer jump-to hits via the ?msg=/around window below.
    const q = (c.req.query('q') ?? '').trim();
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const hits = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, row.conversation.id),
            sql`${messages.text} ilike ${like}`,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(50);
      return c.json({ hits: hits.map(toMessage) });
    }

    // Search-hit deep link — a window centered on a specific message so the
    // client can scroll straight to it instead of landing on the latest page.
    const around = c.req.query('around');
    if (around) {
      const [target] = await db
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.id, around),
            eq(messages.conversationId, row.conversation.id),
          ),
        )
        .limit(1);
      if (!target) return c.json({ error: 'not found' }, 404);
      const HALF = 60;
      const [beforeRows, afterRows] = await Promise.all([
        db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, row.conversation.id),
              lt(messages.createdAt, target.createdAt),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(HALF + 1),
        db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, row.conversation.id),
              gte(messages.createdAt, target.createdAt),
            ),
          )
          .orderBy(asc(messages.createdAt))
          .limit(HALF + 1),
      ]);
      return c.json({
        messages: [...beforeRows.slice(0, HALF).reverse(), ...afterRows.slice(0, HALF)].map(toMessage),
        has_more: beforeRows.length > HALF,
        has_more_after: afterRows.length > HALF,
      });
    }

    // Forward pages — scroll-to-bottom while in an around-window fetches the
    // next chunk with ?after=<latest loaded ts> until it catches the tail.
    const after = c.req.query('after');
    const afterDate = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
    if (afterDate) {
      const fetched = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, row.conversation.id),
            gt(messages.createdAt, afterDate),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(PAGE + 1);
      return c.json({
        messages: fetched.slice(0, PAGE).map(toMessage),
        has_more: fetched.length > PAGE,
      });
    }

    const fetched = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, row.conversation.id),
          ...(beforeDate ? [lt(messages.createdAt, beforeDate)] : []),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(PAGE + 1);
    return c.json({
      messages: fetched.slice(0, PAGE).reverse().map(toMessage),
      has_more: fetched.length > PAGE,
    });
  });

  // Proxied profile picture — Meta CDN urls are signed and expire, so the
  // client never sees them; on a dead link we re-resolve via the Graph API.
  app.get('/:id/avatar', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);

    const avatar = await fetchAvatar(db, row.conversation);
    if (!avatar) return c.json({ error: 'avatar unavailable' }, 404);
    return new Response(avatar.bytes, {
      headers: {
        'content-type': avatar.type,
        'cache-control': 'private, max-age=86400',
      },
    });
  });

  // Operator brief — an LLM digest of the transcript shown when a human
  // opens the thread. Cached on the conversation keyed to last activity;
  // only regenerates when the transcript advanced. ?refresh=1 forces a
  // new pass. { summary: null } means there's nothing worth summarizing
  // (short thread, no usable LLM, over the AI-spend ceiling).
  app.get('/:id/summary', async (c) => {
    const workspaceId = c.get('workspaceId');
    const convId = await resolveConvId(db, c.req.param('id'));
    const [row] = await db
      .select({ conversation: conversations, agent: agents })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, convId), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const brief = await operatorBrief(db, row.agent, row.conversation, {
      force: c.req.query('refresh') === '1',
    });
    return c.json(brief);
  });

  app.post('/:id/takeover', async (c) => {
    try {
      const conv = await takeover(db, c.get('workspaceId'), c.req.param('id'), c.get('user'), c.get('agentScope'));
      return c.json({ conversation: toConversation(conv) });
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/:id/reply', zValidator('json', replyBody), async (c) => {
    try {
      const body = c.req.valid('json');
      const { message: msg, delivery } = await humanReply(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('user'),
        body.text,
        body.attachments,
        undefined,
        undefined,
        c.get('agentScope'),
        { widgets: body.widgets, quickReplies: body.quick_replies },
      );
      // delivery.delivered is only true once the channel actually accepted
      // the send (Meta message id, SDK socket ack, or webchat pull); a
      // rejection — e.g. Meta's closed 24h window — carries the real error.
      return c.json({ message: toMessage(msg), delivery }, 201);
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/:id/agent-send', zValidator('json', replyBody), async (c) => {
    try {
      const body = c.req.valid('json');
      const { message: msg, delivery } = await agentSend(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('user'),
        body.text,
        body.attachments,
        undefined,
        undefined,
        c.get('agentScope'),
        { widgets: body.widgets, quickReplies: body.quick_replies },
      );
      return c.json({ message: toMessage(msg), delivery }, 201);
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Re-attempt channel delivery of a stored message — e.g. after Meta
  // rejected the original send — without duplicating the transcript row.
  app.post('/:id/messages/:mid/resend', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [owned] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))),
      )
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);

    const [msg] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, c.req.param('mid')),
          eq(messages.conversationId, owned.conversation.id),
        ),
      )
      .limit(1);
    const payload = (msg?.payload ?? {}) as {
      internal?: boolean;
      attachments?: AttachmentRef[];
      widgets?: SendOptions['widgets'];
      quick_replies?: SendOptions['quickReplies'];
      effects?: SendOptions['effects'];
    };
    if (!msg || msg.direction === 'in' || payload.internal) {
      return c.json({ error: 'message cannot be resent' }, 400);
    }

    const b = await channelBindingFor(db, owned.conversation.id);
    if (!b) return c.json({ delivery: { delivered: true } }); // nothing to push to
    await takeThreadControl(b.channel, b.platformUserId);

    // Preserve operator attribution on resend — same rules as humanReply.
    const opts: SendOptions & { messageId: string } = {
      messageId: msg.id,
      widgets: payload.widgets,
      quickReplies: payload.quick_replies,
      effects: payload.effects,
    };
    if (msg.direction === 'human') {
      opts.humanAgent = true;
      const [u] = msg.authorId
        ? await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1)
        : [];
      if (u) {
        const ident = await operatorIdentity(db, u, owned.conversation.agentId);
        if (ident.name) {
          opts.senderName = ident.name;
          opts.senderId = u.id;
          opts.senderAvatar = ident.avatar;
        }
      }
    }
    const delivery = await deliverToChannel(
      db,
      owned.conversation.id,
      msg.text ?? '',
      payload.attachments,
      opts,
    );
    return c.json({ delivery });
  });

  // Decide a gated action the suggest card proposed. park=true hands the
  // decision to the whole team — a real pending_action + transcript card +
  // alert (today's machinery). Default runs it inline: the operator is
  // already the approver, so the only transcript artifact is the compact
  // result note decidePendingAction posts. The conversation stays
  // human-owned either way — nothing resumes the agent.
  const runActionBody = z.object({
    name: z.string(),
    args: z.record(z.unknown()).default({}),
    park: z.boolean().optional(),
  });
  app.post('/:id/run-action', zValidator('json', runActionBody), async (c) => {
    const workspaceId = c.get('workspaceId');
    const user = c.get('user');
    const body = c.req.valid('json');
    let convRow;
    let agentRow;
    try {
      ({ conversation: convRow, agent: agentRow } = await getConversationForWorkspace(
        db,
        workspaceId,
        c.req.param('id'),
        c.get('agentScope'),
      ));
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    await touchTakeover(db, convRow.id);

    // Resolve the executable snapshot server-side — never trust a
    // client-supplied ToolDef body. Webhook defs come from the agent's live
    // config; builtins (incl. the customer-facing ones hostedAgent owns)
    // snapshot as {builtin: name} — decidePendingAction dispatches both.
    const tool = toolsFor(agentRow).find((t) => t.name === body.name);
    const { BUILTIN_TOOLS } = await import('../lib/builtinTools.js');
    const { CUSTOMER_BUILTINS } = await import('../lib/hostedAgent.js');
    const builtin =
      BUILTIN_TOOLS.find((b) => b.name === body.name) ?? CUSTOMER_BUILTINS[body.name];
    if (!tool && !builtin) return c.json({ error: `no tool "${body.name}" on this agent` }, 400);
    const snapshot = (tool ?? { name: body.name, builtin: body.name }) as ToolDef & {
      builtin?: string;
    };
    if (body.park) {
      await requestToolApproval(db, agentRow, convRow.id, snapshot, body.args);
      return c.json({ parked: true }, 201);
    }

    // Idempotent only while in-flight — a repeat click on the same pending
    // action decides THAT row instead of stacking a duplicate. A decided
    // twin is history, not a block: approving again re-runs on a fresh row
    // (the tool itself no-ops true duplicates like 'already sent').
    const [existing] = await db
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.conversationId, convRow.id),
          eq(pendingActions.toolName, body.name),
          eq(pendingActions.status, 'pending'),
          sql`${pendingActions.args} = ${JSON.stringify(body.args)}::jsonb`,
        ),
      )
      .limit(1);
    if (existing) {
      const decided = await decidePendingAction(db, existing.id, { id: user.id, name: user.name }, true);
      if (decided === 'not-pending' || !decided) {
        return c.json({ error: 'action could not be decided' }, 409);
      }
      return c.json({ action: { id: decided.action.id, status: decided.action.status, result: decided.action.result } }, 201);
    }
    // Inline approve — a decided pending_action row is the audit trail;
    // decidePendingAction runs it and posts the compact result note.
    const [action] = await db
      .insert(pendingActions)
      .values({
        workspaceId,
        agentId: agentRow.id,
        conversationId: convRow.id,
        toolName: snapshot.name,
        tool: snapshot as never,
        args: body.args as never,
      })
      .returning();
    const decided = await decidePendingAction(db, action.id, { id: user.id, name: user.name }, true);
    if (decided === 'not-pending' || !decided) {
      return c.json({ error: 'action could not be decided' }, 409);
    }
    return c.json({ action: { id: decided.action.id, status: decided.action.status, result: decided.action.result } }, 201);
  });

  // Send a saved in-conversation component as the operator — resolves the
  // WIDGET_REF path (bound tool runs as the operator, {prop} interpolation,
  // state variants) then delivers through humanReply's widget support.
  const sendComponentBody = z.object({
    name: z.string(),
    data: z.record(z.unknown()).optional(),
    // Resolve-only — the console stages the spec as an inline draft and the
    // operator sends it as a normal widget reply.
    preview: z.boolean().optional(),
  });
  app.post('/:id/send-component', zValidator('json', sendComponentBody), async (c) => {
    const workspaceId = c.get('workspaceId');
    const body = c.req.valid('json');
    let convRow;
    let agentRow;
    try {
      ({ conversation: convRow, agent: agentRow } = await getConversationForWorkspace(
        db,
        workspaceId,
        c.req.param('id'),
        c.get('agentScope'),
      ));
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    await touchTakeover(db, convRow.id);
    const [def] = await db
      .select()
      .from(agentWidgets)
      .where(and(eq(agentWidgets.agentId, agentRow.id), eq(agentWidgets.name, body.name)))
      .limit(1);
    if (!def) return c.json({ error: `no component "${body.name}" on this agent` }, 404);
    const cap: { args?: Record<string, unknown>; result?: string; error?: string } = {};
    const spec = await resolveWidgetRef(
      { spec: def.spec as never, states: (def.states ?? undefined) as never, tool: (def.tool ?? undefined) as never },
      body.data,
      toolsFor(agentRow),
      { ...(await loadSecretsMap(db, agentRow.id)), ...(await connectionSecrets(db, agentRow.id)) },
      {
        db,
        convId: convRow.id,
        workspaceId,
        agent: agentRow,
        identity: { emails: new Set(), operator: true },
      },
      new Set(),
      cap,
    );
    if (!spec) return c.json({ error: cap.error ?? 'component produced nothing' }, 400);
    if (body.preview) return c.json({ widget: spec });
    const { message, delivery } = await humanReply(
      db,
      workspaceId,
      convRow.id,
      c.get('user'),
      '',
      undefined,
      undefined,
      undefined,
      c.get('agentScope'),
      { widgets: [spec] },
    );
    return c.json({ message: toMessage(message), delivery }, 201);
  });

  // Operator typing ping — ephemeral flag the /chat poll endpoint exposes so
  // the visitor's widget can show typing dots while a reply is being composed.
  app.post('/:id/typing', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [owned] = await db
      .select({ id: conversations.id, agentId: conversations.agentId })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const user = c.get('user');
    // Same customer-facing identity rules as a sent reply — a show_identity
    // opt-out still shows dots, just anonymously.
    const ident = await operatorIdentity(db, user, owned.agentId);
    void markOperatorTyping(db, owned.id, ident.name);
    // Collision detection — teammates co-viewing the thread see "X is
    // typing" so two operators don't both compose replies.
    bus.publish(workspaceId, {
      type: 'typing',
      data: {
        conversation_id: owned.id,
        name: ident.name ?? undefined,
        kind: 'operator',
        user_id: user.id,
      },
    });
    // Meta channels need an actual sender_action — the webchat poll reads
    // the in-memory flag, but Messenger/IG visitors see nothing without it.
    if (shouldRelayTyping(owned.id)) {
      void channelBindingFor(db, owned.id).then(
        (b) => b && sendChannelTyping(b.channel, b.platformUserId),
      );
    }
    return c.json({ ok: true });
  });

  // Viewing heartbeat — client pings while the conversation is open; the
  // workspace stream republishes the viewer set when it changes.
  app.post('/:id/viewing', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const user = c.get('user');
    const { viewers, changed } = await markViewing(db, owned.id, user.id, user.name);
    if (changed) {
      bus.publish(workspaceId, {
        type: 'presence',
        data: { conversation_id: owned.id, viewers },
      });
    }
    return c.json({ viewers });
  });

  // Internal note — operators only, never delivered to the end user
  app.post('/:id/note', zValidator('json', replyBody), async (c) => {
    try {
      const body = c.req.valid('json');
      if (!body.text.trim()) return c.json({ error: 'note text is required' }, 400);
      const msg = await internalNote(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('user'),
        body.text,
        undefined,
        undefined,
        c.get('agentScope'),
      );
      return c.json({ message: toMessage(msg) }, 201);
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Teach the agent from the thread — admin only
  app.post('/:id/teach', zValidator('json', replyBody), async (c) => {
    try {
      const user = c.get('user');
      const convAgent = await conversationAgent(
        db, c.get('workspaceId'), c.get('agentScope'), c.req.param('id'),
      );
      if (!convAgent) return c.json({ error: 'not found' }, 404);
      const effRole = await agentRoleFor(
        db, user.id, c.get('role'), c.get('agentScope'), convAgent.agent.id, c.get('workspaceId'),
      );
      if (!isAdminRole(effRole)) {
        return c.json({ error: 'only admins can teach the agent' }, 403);
      }
      const body = c.req.valid('json');
      if (!body.text.trim()) return c.json({ error: 'teach text is required' }, 400);
      const { message, knowledgeCount } = await teachAgent(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        user,
        body.text,
      );
      return c.json({ message: toMessage(message), knowledge_count: knowledgeCount }, 201);
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/:id/resume', async (c) => {
    try {
      const conv = await resume(db, c.get('workspaceId'), c.req.param('id'), c.get('user'), c.get('agentScope'));
      return c.json({ conversation: toConversation(conv) });
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Ask for a suggested reply: agent webhook if configured, else Janis-side LLM.
  // `instruction` is optional operator guidance that shapes the draft —
  // forwarded to the agent on suggestion.request (external agents may
  // ignore it; hosted agents draft to it). Body is optional — stale
  // console bundles and other callers POST bare; a strict json validator
  // would 400 them.
  const suggestBody = z.object({
    instruction: z.string().trim().min(1).max(500).optional(),
  });
  app.post('/:id/suggest', async (c) => {
    const parsed = suggestBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid suggest body' }, 400);
    try {
      const { conversation, agent } = await getConversationForWorkspace(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('agentScope'),
      );
      if (conversation.state === 'archived') {
        return c.json({ error: 'conversation is archived' }, 409);
      }
      await touchTakeover(db, conversation.id);
      const result = await requestSuggestion(
        db,
        conversation,
        agent,
        parsed.data.instruction,
      );
      return c.json(
        result.mode === 'llm'
          ? { mode: 'llm', suggestion: toSuggestion(result.suggestion) }
          : { mode: 'agent' },
      );
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Mark a suggestion used/dismissed
  app.post(
    '/:id/suggestions/:sid/status',
    zValidator('json', z.object({ status: z.enum(['used', 'dismissed']) })),
    async (c) => {
      const { conversation } = await getConversationForWorkspace(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('agentScope'),
      );
      await touchTakeover(db, conversation.id);
      const [row] = await db
        .update(suggestions)
        .set({ status: c.req.valid('json').status })
        .where(
          and(
            eq(suggestions.id, c.req.param('sid')),
            eq(suggestions.conversationId, conversation.id),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ suggestion: toSuggestion(row) });
    },
  );

  // Delete a conversation and its transcript — children have no FK cascade,
  // so remove them explicitly. usage_events keeps billing rows (fk nulled).
  app.delete('/:id', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const id = row.conversation.id;

    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(alerts).where(eq(alerts.conversationId, id));
    await db.delete(suggestions).where(eq(suggestions.conversationId, id));
    await db.delete(slackThreads).where(eq(slackThreads.conversationId, id));
    await db.delete(channelBindings).where(eq(channelBindings.conversationId, id));
    await db
      .update(usageEvents)
      .set({ conversationId: null })
      .where(eq(usageEvents.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
    return c.json({ ok: true });
  });

  app.patch('/:id', zValidator('json', patchBody), async (c) => {
    const workspaceId = c.get('workspaceId');
    const user = c.get('user');
    const body = c.req.valid('json');

    const [owned] = await db
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        state: conversations.state,
        assigneeId: conversations.assigneeId,
        intent: conversations.intent,
        tags: conversations.tags,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);

    const [row] = await db
      .update(conversations)
      .set({
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.assignee_id !== undefined ? { assigneeId: body.assignee_id } : {}),
        ...(body.state !== undefined ? { state: body.state } : {}),
        // stamp resolution time; a reopen clears it so re-archiving re-times
        ...(body.state === 'archived' ? { archivedAt: new Date() } : {}),
        ...(body.state !== undefined && body.state !== 'archived' ? { archivedAt: null } : {}),
        ...(body.is_starred !== undefined ? { isStarred: body.is_starred } : {}),
        ...(body.is_unread !== undefined ? { isUnread: body.is_unread } : {}),
        ...(body.snoozed_until !== undefined
          ? { snoozedUntil: body.snoozed_until ? new Date(body.snoozed_until) : null }
          : {}),
        ...(body.intent !== undefined
          ? {
              intent: body.intent,
              intentSource: body.intent ? 'manual' : 'ai',
              intentCheckedAt: body.intent ? new Date() : null,
            }
          : {}),
      })
      .where(eq(conversations.id, owned.id))
      .returning();
    // Vanished between the visibility check and the update — no row to run
    // effects on. Reported 2026-10-20: undefined row → 'reading id' crash.
    if (!row) return c.json({ error: 'not found' }, 404);

    // Side effects + operator audit trail — the same implementation /bulk
    // uses: transition line + hooks + CSAT on archive + Meta thread release
    // leaving 'human' + open-alert sweep, and attributed notes for the
    // assignee/topic/tag diffs.
    await applyConvEffects(
      db,
      workspaceId,
      owned,
      row,
      {
        state: body.state,
        assigneeId: body.assignee_id,
        tags: body.tags,
        intent: body.intent,
      },
      user,
    );
    return c.json({ conversation: toConversation(row) });
  });

  return app;
}
