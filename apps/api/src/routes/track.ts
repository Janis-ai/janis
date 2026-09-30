import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { analyticsEvents } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

/** Allowlist — keeps the table a clean funnel instead of a junk drawer. */
const EVENTS = z.enum([
  'discovery_card_click',
  'discovery_card_dismissed',
  'tab_view',
  'onboarding_step_click',
]);

/** POST /api/track — session-authed activation events. Fire-and-forget from
 *  the client; always 204 (even on unknown event — no error UI for metrics). */
export function trackRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        event: EVENTS,
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const { event, meta } = c.req.valid('json');
      await db.insert(analyticsEvents).values({
        workspaceId: c.get('workspaceId'),
        userId: c.get('user').id,
        event,
        meta: meta ?? null,
      });
      return c.body(null, 204);
    },
  );

  return app;
}
