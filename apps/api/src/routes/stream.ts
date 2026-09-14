import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from '../db/client.js';
import { bus } from '../lib/bus.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

/** Workspace-scoped SSE stream for live inbox updates. */
export function streamRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', (c) => {
    const workspaceId = c.get('workspaceId');
    return streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe(workspaceId, (event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
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
