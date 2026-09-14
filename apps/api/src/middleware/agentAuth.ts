import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';

type AgentRow = typeof agents.$inferSelect;

export interface AgentAuthEnv {
  Variables: { agent: AgentRow };
}

/** Bearer-token auth for agent-facing /v1 routes. */
export function agentAuth(db: Db) {
  return createMiddleware<AgentAuthEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^bearer\s+/i, '').trim();
    if (!token) return c.json({ error: 'missing bearer token' }, 401);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.apiKeyHash, sha256(token)))
      .limit(1);
    if (!agent) return c.json({ error: 'invalid api key' }, 401);

    c.set('agent', agent);
    await next();
  });
}
