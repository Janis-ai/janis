import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { suppressions } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { normalizeAddress } from '../lib/sendPolicy.js';
import { audit } from '../lib/audit.js';

/** Suppression list — never-send addresses for this workspace. Bounce/
 *  complaint webhooks and dead-number callbacks write here too; the send
 *  policy checks it immediately before every bulk dispatch. Admin-only. */
export function suppressionRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  app.use('/*', adminOnly);

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspaceId, c.get('workspaceId')))
      .orderBy(desc(suppressions.createdAt))
      .limit(500);
    return c.json({
      suppressions: rows.map((s) => ({
        id: s.id,
        address: s.address,
        kind: s.kind,
        reason: s.reason,
        source: s.source,
        created_at: s.createdAt.toISOString(),
      })),
    });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        address: z.string().min(3).max(320),
        kind: z.enum(['all', 'email', 'phone']).optional(),
        reason: z.enum(['manual', 'bounce', 'complaint', 'dead_number']).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const workspaceId = c.get('workspaceId');
      const [row] = await db
        .insert(suppressions)
        .values({
          workspaceId,
          address: normalizeAddress(body.address),
          kind: body.kind ?? 'all',
          reason: body.reason ?? 'manual',
          source: 'manual',
        })
        .onConflictDoNothing()
        .returning({ id: suppressions.id });
      await audit(db, {
        workspaceId,
        userId: c.get('user').id,
        userName: c.get('user').name,
        action: 'suppression.add',
        targetType: 'suppression',
        targetId: row?.id,
        meta: { address: body.address, kind: body.kind ?? 'all' },
      });
      return c.json({ ok: true, id: row?.id ?? null });
    },
  );

  app.delete('/:id', async (c) => {
    const workspaceId = c.get('workspaceId');
    const deleted = await db
      .delete(suppressions)
      .where(and(eq(suppressions.id, c.req.param('id')), eq(suppressions.workspaceId, workspaceId)))
      .returning({ id: suppressions.id });
    if (!deleted.length) return c.json({ error: 'not found' }, 404);
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'suppression.remove',
      targetType: 'suppression',
      targetId: c.req.param('id'),
    });
    return c.json({ ok: true });
  });

  return app;
}
