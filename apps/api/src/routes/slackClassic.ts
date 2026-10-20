// POST /slack/classic/receive — the new-stack equivalent of wordhop-slack's
// POST /wordhopapi/receive. Accepts legacy-shaped events (message-type
// header + body) for classic-mode installations:
//   - shadow replay: harness/wordhopapi mirrors real events here while
//     wordhop-slack remains authoritative for customers
//   - dry run: ?dry=1 computes the full post/suppress decision set without
//     touching Slack (returns payloads for the comparator)
// Auth: x-classic-key == env.classicIngestKey.

import { Hono } from 'hono';
import { env } from '../env.js';
import type { Db } from '../db/client.js';
import { handleLegacyEvent } from '../lib/slackClassic/index.js';
import type { EventType, LegacyEvent } from '../lib/slackClassic/types.js';

export function slackClassicRoutes(db: Db) {
  const app = new Hono();

  app.post('/receive', async (c) => {
    if (!env.classicIngestKey || c.req.header('x-classic-key') !== env.classicIngestKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const type = (c.req.header('message-type') ?? '') as EventType;
    if (!type) return c.json({ error: 'message-type header required' }, 400);
    const msg = (await c.req.json().catch(() => null)) as LegacyEvent | null;
    if (!msg || typeof msg !== 'object') return c.json({ error: 'json body required' }, 400);

    const dry = c.req.query('dry') === '1' || c.req.query('dry') === 'true';
    const result = await handleLegacyEvent(db, type, msg, { dry });
    // Legacy /wordhopapi/receive always 200s ('Success!') — keep the contract
    // but return the decision payload for the shadow comparator.
    return c.json({ ok: true, ...result });
  });

  return app;
}
