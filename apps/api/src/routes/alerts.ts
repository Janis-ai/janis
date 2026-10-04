import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentScopeCond, agentVis } from '../lib/access.js';
import { bus } from '../lib/bus.js';
import { toAlert } from '../lib/serializers.js';
import { ALERT_LABEL, systemNote } from '../lib/systemNote.js';

const listQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
});

export function alertRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', zValidator('query', listQuery), async (c) => {
    const workspaceId = c.get('workspaceId');
    const q = c.req.valid('query');
    const conditions = agentVis(workspaceId, c.get('agentScope'));
    if (q.status) conditions.push(eq(alerts.status, q.status));

    const rows = await db
      .select({ alert: alerts })
      .from(alerts)
      .innerJoin(conversations, eq(alerts.conversationId, conversations.id))
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(alerts.createdAt))
      .limit(200);

    return c.json({ alerts: rows.map((r) => toAlert(r.alert)) });
  });

  app.post('/:id/status', zValidator('json', z.object({
    status: z.enum(['acknowledged', 'resolved']),
  })), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { status } = c.req.valid('json');
    const scope = agentScopeCond(c.get('agentScope'));
    const [row] = await db
      .update(alerts)
      .set({ status })
      .where(
        and(
          eq(alerts.id, c.req.param('id')),
          sql`exists (
            select 1 from ${conversations}
            join ${agents} on ${conversations.agentId} = ${agents.id}
            where ${conversations.id} = ${alerts.conversationId}
              and ${agents.workspaceId} = ${workspaceId}
              ${scope ? sql`and ${scope}` : sql``}
          )`,
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    // Republish so other open clients clear the dot without waiting for an
    // unrelated event — every other resolve path already does this.
    bus.publish(workspaceId, { type: 'alert', data: toAlert(row) });
    // Audit line in the transcript — who closed what, and on what
    const actor = c.get('user');
    const label = ALERT_LABEL[row.type] ?? row.type;
    await systemNote(
      db,
      workspaceId,
      row.conversationId,
      `${actor.name} ${status === 'resolved' ? 'resolved' : 'acknowledged'} the alert — ${label}${row.detail ? ` (${row.detail})` : ''}`,
      'alert_status',
    );
    return c.json({ alert: toAlert(row) });
  });

  return app;
}
