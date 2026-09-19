import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { sendPushToEndpoint } from '../lib/notify.js';
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
    const userId = c.get('user').id;
    const inserted = await db
      .insert(pushSubscriptions)
      .values({ userId, endpoint: body.endpoint, keys: body.keys })
      .onConflictDoNothing()
      .returning({ endpoint: pushSubscriptions.endpoint });
    if (inserted.length === 0) {
      // Re-registration of a known device — refresh ownership/keys silently so
      // the client can re-sync on every load without spamming a push.
      await db
        .update(pushSubscriptions)
        .set({ userId, keys: body.keys })
        .where(eq(pushSubscriptions.endpoint, body.endpoint));
    } else {
      // Confirm end-to-end: if the user sees this, VAPID + the endpoint all work.
      void sendPushToEndpoint(
        { endpoint: body.endpoint, keys: body.keys },
        {
          title: 'Push notifications enabled',
          body: "You'll get Janis alerts here when an agent needs a human.",
          url: '/conversations',
        },
      );
    }
    return c.json({ ok: true }, 201);
  });

  // Client-reported subscribe failures — surfaced in Cloud Run logs so push
  // breakage is diagnosable without a user's browser console.
  app.post(
    '/subscribe-failed',
    zValidator(
      'json',
      z.object({ error: z.string().max(500), context: z.string().max(60).optional() }),
    ),
    (c) => {
      const { error, context } = c.req.valid('json');
      console.error(
        `[push] subscribe failed — user=${c.get('user').id} context=${context ?? '-'} error=${error}`,
      );
      return c.json({ ok: true });
    },
  );

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
