import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, messages } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toConversation, toMessage } from '../lib/serializers.js';

export function searchRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/search?q=... → conversations + message hits across the workspace
  app.get('/', async (c) => {
    const workspaceId = c.get('workspaceId');
    const q = (c.req.query('q') ?? '').trim();
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
          eq(agents.workspaceId, workspaceId),
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
