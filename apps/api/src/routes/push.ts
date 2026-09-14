import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { env } from '../env.js';

const subscription = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export function pushRoutes(db: Db) {
  const app = new Hono<SessionEnv>();

  // public key is needed before the client can subscribe
  app.get('/vapid-key', (c) => c.json({ publicKey: env.vapidPublicKey || null }));

  app.use('/*', sessionAuth(db));

  app.post('/subscriptions', zValidator('json', subscription), async (c) => {
    const body = c.req.valid('json');
    await db
      .insert(pushSubscriptions)
      .values({ userId: c.get('user').id, endpoint: body.endpoint, keys: body.keys })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: c.get('user').id, keys: body.keys },
      });
    return c.json({ ok: true }, 201);
  });

  app.delete('/subscriptions', zValidator('json', z.object({ endpoint: z.string().url() })), async (c) => {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, c.req.valid('json').endpoint),
          eq(pushSubscriptions.userId, c.get('user').id),
        ),
      );
    return c.json({ ok: true });
  });

  return app;
}
