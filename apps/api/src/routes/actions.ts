import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pendingActions } from '../db/schema.js';
import { decidePendingAction } from '../lib/approvals.js';
import { runHostedEvent } from '../lib/hostedAgent.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

const decideBody = z.object({ decision: z.enum(['approved', 'denied']) });

export function actionRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // POST /api/actions/:id/decide — approve or deny a gated tool call. Any
  // workspace member may decide (same bar as takeover).
  app.post('/:id/decide', zValidator('json', decideBody), async (c) => {
    const workspaceId = c.get('workspaceId');
    const user = c.get('user');
    const [action] = await db
      .select()
      .from(pendingActions)
      .where(and(eq(pendingActions.id, c.req.param('id')), eq(pendingActions.workspaceId, workspaceId)))
      .limit(1);
    if (!action) return c.json({ error: 'not found' }, 404);

    const decided = await decidePendingAction(
      db,
      action.id,
      { id: user.id, name: user.name },
      c.req.valid('json').decision === 'approved',
    );
    if (decided === 'not-pending') return c.json({ error: 'already decided' }, 409);
    if (!decided) return c.json({ error: 'not found' }, 404);

    // Resume the agent so it can close the loop with the customer.
    void runHostedEvent(db, decided.agent, {
      type: 'message.user',
      conversation_id: decided.conv.externalId,
      janis_conversation_id: decided.conv.id,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return c.json({ ok: true, status: decided.action.status, result: decided.action.result });
  });

  return app;
}
