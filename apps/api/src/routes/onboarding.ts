import { Hono } from 'hono';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, channels, conversations, messages } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentVis } from '../lib/access.js';

const count = sql<number>`count(*)::int`;

/** Console endpoint mounted at /api/onboarding (session auth). */
export function onboardingRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const ws = c.get('workspaceId');
    const vis = agentVis(ws, c.get('agentScope'));
    const [[a], [live], [ch], [conv], [human]] = await Promise.all([
      db.select({ n: count }).from(agents).where(and(...vis)),
      db
        .select({ n: count })
        .from(agents)
        .where(and(...vis, isNotNull(agents.lastSeenAt))),
      db.select({ n: count }).from(channels).where(eq(channels.workspaceId, ws)),
      db
        .select({ n: count })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(and(...vis)),
      // Taken over = currently human-owned, or has a human reply on record.
      // human_since alone won't do — resume clears it back to null.
      db
        .select({ n: sql<number>`count(distinct ${conversations.id})::int` })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .leftJoin(
          messages,
          and(eq(messages.conversationId, conversations.id), eq(messages.direction, 'human')),
        )
        .where(
          and(...vis, or(isNotNull(conversations.humanSince), isNotNull(messages.id))),
        ),
    ]);

    const steps = [
      {
        key: 'create_agent',
        label: 'Create your first agent',
        hint: 'Agents page → New agent → copy the API key',
        done: a.n > 0,
      },
      {
        key: 'agent_live',
        label: 'Bring the agent online',
        hint: 'Run the agent template with the key, or point your own agent at /v1/events',
        done: live.n > 0,
      },
      {
        key: 'add_channel',
        label: 'Connect a channel',
        hint: 'Integrations → Connect Facebook → pick a Page, IG, or WhatsApp number',
        done: ch.n > 0,
      },
      {
        key: 'first_message',
        label: 'Receive your first conversation',
        hint: 'Send a message to the connected channel',
        done: conv.n > 0,
      },
      {
        key: 'take_over',
        label: 'Take over a conversation',
        hint: 'Open a conversation → Take over → reply as a human',
        done: human.n > 0,
      },
    ];
    return c.json({ steps, complete: steps.every((s) => s.done) });
  });

  return app;
}
