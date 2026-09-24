import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql } from 'drizzle-orm';
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
import { fetchAvatar } from '../lib/avatar.js';
import { markOperatorTyping } from '../lib/typingState.js';
import {
  channelBindingFor,
  deliverToChannel,
  releaseThreadControl,
  takeThreadControl,
  type AttachmentRef,
} from '../lib/channels.js';

const listQuery = z.object({
  // 'unread'/'starred' are flags and 'handoff_offer'/'failure' are open-alert
  // signals — all ride the same param as the four real lifecycle states
  state: z
    .enum(['active', 'needs_human', 'human', 'archived', 'unread', 'starred', 'handoff_offer', 'failure'])
    .optional(),
  agent_id: z.string().uuid().optional(),
  attention: z.enum(['1', 'true']).optional(), // needs_human OR has open alerts
  assignee: z.enum(['me']).optional(), // only conversations assigned to the caller
});

const patchBody = z.object({
  tags: z.array(z.string()).optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  state: z.enum(['active', 'needs_human', 'archived']).optional(),
  is_starred: z.boolean().optional(),
  is_unread: z.boolean().optional(),
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

    const conditions = [eq(agents.workspaceId, workspaceId)];
    if (q.state === 'unread') conditions.push(eq(conversations.isUnread, true));
    else if (q.state === 'starred') conditions.push(eq(conversations.isStarred, true));
    else if (q.state === 'handoff_offer' || q.state === 'failure')
      // signal filter: any open alert of that type, whatever the lifecycle state
      conditions.push(
        sql`exists (
          select 1 from ${alerts}
          where ${alerts.conversationId} = ${conversations.id}
            and ${alerts.status} = 'open'
            and ${alerts.type} = ${q.state}
        )`,
      );
    else if (q.state) conditions.push(eq(conversations.state, q.state));
    else conditions.push(ne(conversations.state, 'archived')); // archived hidden unless filtered
    if (q.agent_id) conditions.push(eq(conversations.agentId, q.agent_id));
    if (q.assignee === 'me') conditions.push(eq(conversations.assigneeId, c.get('user').id));
    if (q.attention) {
      conditions.push(inArray(conversations.state, ['needs_human', 'human']));
    }

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
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200);

    return c.json({
      conversations: rows.map((r) => toConversation(r.conversation, r.openAlertCount)),
    });
  });

  // count of conversations needing a human — powers the nav badge
  app.get('/attention-count', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          inArray(conversations.state, ['needs_human', 'human']),
        ),
      );
    return c.json({ count });
  });

  app.get('/:id', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [row] = await db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
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
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
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
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
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
      const conv = await takeover(db, c.get('workspaceId'), c.req.param('id'), c.get('user'));
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
        and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)),
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
      if (u && u.showIdentity !== false) {
        opts.senderName = u.displayName || u.name.split(' ')[0] || u.name;
        opts.senderId = u.id;
        opts.senderAvatar = u.avatarUrl;
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
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const user = c.get('user');
    // Same customer-facing identity rules as a sent reply — a show_identity
    // opt-out still shows dots, just anonymously.
    const name =
      user.showIdentity === false
        ? null
        : user.displayName || user.name.split(' ')[0] || user.name;
    markOperatorTyping(owned.id, name);
    return c.json({ ok: true });
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
      if (c.get('role') !== 'admin') {
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
      const conv = await resume(db, c.get('workspaceId'), c.req.param('id'), c.get('user'));
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
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
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
      .where(and(eq(conversations.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);

    const [row] = await db
      .update(conversations)
      .set({
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.assignee_id !== undefined ? { assigneeId: body.assignee_id } : {}),
        ...(body.state !== undefined ? { state: body.state } : {}),
        ...(body.is_starred !== undefined ? { isStarred: body.is_starred } : {}),
        ...(body.is_unread !== undefined ? { isUnread: body.is_unread } : {}),
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
