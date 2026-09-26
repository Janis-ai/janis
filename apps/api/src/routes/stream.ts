import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

/** Workspace-scoped SSE stream for live inbox updates. Agent-scoped users
 * get a filtered view — events for agents outside their grant are dropped
 * (they'd leak message previews of conversations they can't open). */
export function streamRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', (c) => {
    const workspaceId = c.get('workspaceId');
    const scope = c.get('agentScope');
    // conversation → agent resolution cache; events don't always carry
    // agent_id, and looking one up per event is cheap enough at alert volume
    const convAgent = new Map<string, string | null>();
    const visible = async (data: Record<string, unknown>) => {
      if (!scope) return true;
      const agentId = data.agent_id as string | undefined;
      if (agentId) return agentId in scope;
      const convId = (data.conversation_id ?? data.id) as string | undefined;
      if (!convId) return false;
      if (!convAgent.has(convId)) {
        const [row] = await db
          .select({ agentId: conversations.agentId })
          .from(conversations)
          .where(eq(conversations.id, convId))
          .limit(1);
        convAgent.set(convId, row?.agentId ?? null);
      }
      const a = convAgent.get(convId);
      return a != null && a in scope;
    };
    return streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe(workspaceId, (event) => {
        void (async () => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          if (!(await visible(data))) return;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
        })().catch(() => {});
      });

      // keepalive — prevents proxies/clients from dropping idle connections
      const keepalive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }), 25_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        unsubscribe();
      });

      // hold the stream open
      await new Promise<void>(() => {});
    });
  });

  return app;
}
