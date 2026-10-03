import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alerts,
  channelBindings,
  conversations,
  messages,
  slackThreads,
  suggestions,
  usageEvents,
  users,
} from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toAlert, toConversation, toMessage, toSuggestion } from '../lib/serializers.js';
import { convListConditions, convListQuery } from '../lib/convFilters.js';
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
import { sendCsatPrompt } from '../lib/csat.js';
import { emitHookEvent } from '../lib/hooks.js';
import { fetchAvatar } from '../lib/avatar.js';
import { markOperatorTyping, shouldRelayTyping } from '../lib/typingState.js';
import { markViewing } from '../lib/presence.js';
import {
  channelBindingFor,
  deliverToChannel,
  releaseThreadControl,
  sendChannelTyping,
  takeThreadControl,
  type AttachmentRef,
} from '../lib/channels.js';

const listQuery = convListQuery;

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
  })
  .refine((d) => d.text.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'text or attachments required',
  });

export function conversationRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', zValidator('query', listQuery), async (c) => {
    const workspaceId = c.get('workspaceId');
    const q = c.req.valid('query');

    const conditions = convListConditions(q, workspaceId, c.get('user').id, c.get('agentScope'));

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
      conversations: page.map((r) => toConversation(r.conversation, r.openAlertCount)),
      has_more: hasMore,
      next_cursor: nextCursor,
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
    const [[{ count }], [{ count: unread }]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(
          and(
            ...scope,
            ...agentCond,
            inArray(conversations.state, ['needs_human', 'human']),
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
            sql`(${conversations.snoozedUntil} is null or ${conversations.snoozedUntil} <= now())`,
          ),
        ),
    ]);
    return c.json({ count, unread });
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

    // Same side effects the single PATCH performs: Meta thread control is
    // released when leaving 'human', and archiving fires the one-shot CSAT ask.
    if (action === 'archive' || action === 'unarchive') {
      for (const r of rows) {
        const conv = r.conversations;
        if (conv.state === 'human') {
          void (async () => {
            const b = await channelBindingFor(db, conv.id);
            if (b) await releaseThreadControl(b.channel, b.platformUserId);
          })();
        }
        if (action === 'archive' && conv.state !== 'archived') {
          const archivedConv = { ...conv, archivedAt: now };
          void sendCsatPrompt(db, archivedConv).catch(() => {});
          emitHookEvent(db, conv.agentId, 'conversation_resolved', archivedConv);
        }
      }
    }

    // one event per row so detail-page subscribers see the new state —
    // the list invalidates on the first and ignores the rest
    const nextState =
      action === 'archive' ? 'archived' : action === 'unarchive' ? 'active' : null;
    for (const r of rows) {
      bus.publish(workspaceId, {
        type: 'conversation',
        data: { id: r.conversations.id, state: nextState ?? r.conversations.state },
      });
    }
    return c.json({ updated: ownedIds.length });
  });

  app.get('/:id', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
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
    return c.json({
      conversation: toConversation(
        row.conversation,
        convAlerts.filter((a) => a.status === 'open').length,
      ),
      messages: msgs.map(toMessage),
      messages_has_more: msgRows.length > PAGE,
      alerts: convAlerts.map(toAlert),
      suggestions: convSuggestions.map(toSuggestion),
    });
  });

  // Older transcript pages — the initial load returns the latest page;
  // scrolling to the top fetches the next chunk with ?before=<oldest ts>.
  app.get('/:id/messages', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), ...agentVis(workspaceId, c.get('agentScope'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);

    const before = c.req.query('before');
    const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
    const PAGE = 100;

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
    const payload = (msg?.payload ?? {}) as { internal?: boolean; attachments?: AttachmentRef[] };
    if (!msg || msg.direction === 'in' || payload.internal) {
      return c.json({ error: 'message cannot be resent' }, 400);
    }

    const b = await channelBindingFor(db, owned.conversation.id);
    if (!b) return c.json({ delivery: { delivered: true } }); // nothing to push to
    await takeThreadControl(b.channel, b.platformUserId);

    // Preserve operator attribution on resend — same rules as humanReply.
    const opts: { messageId: string; senderName?: string; senderId?: string; senderAvatar?: string | null } = {
      messageId: msg.id,
    };
    if (msg.direction === 'human' && msg.authorId) {
      const [u] = await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1);
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

  // Ask for a suggested reply: agent webhook if configured, else Janis-side LLM
  app.post('/:id/suggest', async (c) => {
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
      const result = await requestSuggestion(db, conversation, agent);
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
    const body = c.req.valid('json');

    const [owned] = await db
      .select({ id: conversations.id, state: conversations.state })
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

    // Meta handover protocol: releasing back to the agent returns the thread
    // to the channel's configured secondary receiver (the bot platform's app).
    // ('human' transitions go through the takeover service, already handled.)
    if (body.state !== undefined && owned.state === 'human') {
      void (async () => {
        const b = await channelBindingFor(db, owned.id);
        if (b) await releaseThreadControl(b.channel, b.platformUserId);
      })();
    }

    // Archiving resolves the conversation — send the one-shot CSAT prompt so
    // the customer's next reply lands as a rating, not another turn.
    if (body.state === 'archived' && owned.state !== 'archived') {
      void sendCsatPrompt(db, row).catch(() => {});
      emitHookEvent(db, row.agentId, 'conversation_resolved', row);
    }
    if (body.state === 'needs_human' && owned.state !== 'needs_human') {
      emitHookEvent(db, row.agentId, 'conversation_escalated', row);
    }

    // Manually un-flagging back to the agent resolves open alerts — same
    // as takeover does, so future handoffs can re-alert
    if (body.state === 'active') {
      const resolved = await db
        .update(alerts)
        .set({ status: 'resolved' })
        .where(and(eq(alerts.conversationId, owned.id), eq(alerts.status, 'open')))
        .returning();
      for (const a of resolved) {
        bus.publish(workspaceId, { type: 'alert', data: toAlert(a) });
      }
    }

    bus.publish(workspaceId, {
      type: 'conversation',
      data: { id: row.id, state: row.state },
    });
    return c.json({ conversation: toConversation(row) });
  });

  return app;
}
