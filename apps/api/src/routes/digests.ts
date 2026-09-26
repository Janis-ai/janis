import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toDigest } from '../lib/serializers.js';
import { generateDigest } from '../services/digest.js';

export function digestRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    // Digests are workspace-wide summaries — nothing here for scoped users.
    if (c.get('agentScope')) return c.json({ digests: [] });
    const rows = await db
      .select()
      .from(digests)
      .where(eq(digests.workspaceId, c.get('workspaceId')))
      .orderBy(desc(digests.createdAt))
      .limit(30);
    return c.json({ digests: rows.map(toDigest) });
  });

  app.post('/generate', async (c) => {
    if (c.get('agentScope')) return c.json({ error: 'forbidden' }, 403);
    const d = await generateDigest(db, c.get('workspaceId'));
    return c.json({ digest: d }, 201);
  });

  return app;
}
