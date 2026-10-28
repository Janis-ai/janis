import { createMiddleware } from 'hono/factory';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentApiKeys, agents } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';

type AgentRow = typeof agents.$inferSelect;

export interface AgentAuthEnv {
  Variables: { agent: AgentRow };
}

/** Bearer-token auth for agent-facing /v1 routes. */
export function agentAuth(db: Db) {
  return createMiddleware<AgentAuthEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token =
      header.replace(/^bearer\s+/i, '').trim() || (c.req.header('x-api-key') ?? '').trim();
    if (!token) return c.json({ error: 'missing api key' }, 401);

    const hash = sha256(token);
    // Named keys first — each is independently revocable; revoked rows fail.
    const [keyRow] = await db
      .select({ agent: agents, key: agentApiKeys })
      .from(agentApiKeys)
      .innerJoin(agents, eq(agentApiKeys.agentId, agents.id))
      .where(and(eq(agentApiKeys.keyHash, hash), isNull(agentApiKeys.revokedAt)))
      .limit(1);
    if (keyRow) {
      // Usage ledger for the console — fire-and-forget, never delays auth.
      void db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, keyRow.key.id))
        .catch(() => {});
      c.set('agent', keyRow.agent);
      await next();
      return;
    }

    // Legacy single key on the agent row — the implicit "Primary" key.
    const [agent] = await db.select().from(agents).where(eq(agents.apiKeyHash, hash)).limit(1);
    if (!agent) return c.json({ error: 'invalid api key' }, 401);

    c.set('agent', agent);
    await next();
  });
}
