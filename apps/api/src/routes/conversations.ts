import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
} from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toAlert, toConversation, toMessage, toSuggestion } from '../lib/serializers.js';
import { bus } from '../lib/bus.js';
import {
  agentSend,
  getConversationForWorkspace,
  humanReply,
  resume,
  takeover,
  TakeoverError,
} from '../services/takeover.js';
import { requestSuggestion } from '../services/suggestions.js';
import { fetchAvatar } from '../lib/avatar.js';

const listQuery = z.object({
  state: z.enum(['active', 'needs_human', 'human', 'archived', 'unread', 'starred']).optional(),
  agent_id: z.string().uuid().optional(),
  attention: z.enum(['1', 'true']).optional(), // needs_human OR has open alerts
  assignee: z.enum(['me']).optional(), // only conversations assigned to the caller
});

const patchBody = z.object({
  tags: z.array(z.string()).optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  state: z.enum(['active', 'archived']).optional(),
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
    else if (q.state) conditions.push(eq(conversations.state, q.state));
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

    // opening a conversation clears the unread flag
    if (row.conversation.isUnread) {
      await db
        .update(conversations)
        .set({ isUnread: false })
        .where(eq(conversations.id, row.conversation.id));
      row.conversation.isUnread = false;
    }

    const [msgs, convAlerts, convSuggestions] = await Promise.all([
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, row.conversation.id))
        .orderBy(messages.createdAt)
        .limit(500),
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

    return c.json({
      conversation: toConversation(
        row.conversation,
        convAlerts.filter((a) => a.status === 'open').length,
      ),
      messages: msgs.map(toMessage),
      alerts: convAlerts.map(toAlert),
      suggestions: convSuggestions.map(toSuggestion),
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
      const msg = await humanReply(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('user'),
        body.text,
        body.attachments,
      );
      return c.json({ message: toMessage(msg) }, 201);
    } catch (err) {
      if (err instanceof TakeoverError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/:id/agent-send', zValidator('json', replyBody), async (c) => {
    try {
      const body = c.req.valid('json');
      const msg = await agentSend(
        db,
        c.get('workspaceId'),
        c.req.param('id'),
        c.get('user'),
        body.text,
        body.attachments,
      );
      return c.json({ message: toMessage(msg) }, 201);
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
      if (conversation.state !== 'human') {
        return c.json({ error: 'take over the conversation before requesting a suggestion' }, 409);
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
  app.delete('/:id', async (c) => {
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
      .select({ id: conversations.id })
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
