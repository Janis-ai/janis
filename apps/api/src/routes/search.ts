import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toConversation, toMessage } from '../lib/serializers.js';
import { convListConditions, convListQuery } from '../lib/convFilters.js';

const searchQuery = convListQuery.extend({
  q: z.string().optional(),
});

export function searchRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/search?q=... → conversations + message hits across the workspace.
  // Accepts the same filters as GET /api/conversations so a search + filter
  // combination behaves like the filtered list.
  app.get('/', zValidator('query', searchQuery), async (c) => {
    const workspaceId = c.get('workspaceId');
    const params = c.req.valid('query');
    const q = (params.q ?? '').trim();
    if (!q) return c.json({ conversations: [], messages: [] });
    const like = `%${q.replace(/[%_]/g, '')}%`;

    const convRows = await db
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
      .where(
        and(
          ...convListConditions(params, workspaceId, c.get('user').id, c.get('agentScope')),
          sql`(
            ${conversations.externalId} ilike ${like}
            or ${conversations.userProfile}::text ilike ${like}
            or exists (
              select 1 from ${messages}
              where ${messages.conversationId} = ${conversations.id}
                and ${messages.text} ilike ${like}
            )
          )`,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(50);

    const convIds = convRows.map((r) => r.conversation.id);
    const msgHits = convIds.length
      ? await db
          .select()
          .from(messages)
          .where(
            and(inArray(messages.conversationId, convIds), sql`${messages.text} ilike ${like}`),
          )
          .orderBy(desc(messages.createdAt))
          .limit(50)
      : [];

    return c.json({
      conversations: convRows.map((r) => toConversation(r.conversation, r.openAlertCount)),
      messages: msgHits.map(toMessage),
    });
  });

  return app;
}
