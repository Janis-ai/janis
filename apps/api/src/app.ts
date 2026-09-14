import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Db } from './db/client.js';
import { env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { v1Routes } from './routes/v1.js';
import { agentRoutes } from './routes/agents.js';
import { conversationRoutes } from './routes/conversations.js';
import { alertRoutes } from './routes/alerts.js';
import { ruleRoutes } from './routes/rules.js';
import { streamRoutes } from './routes/stream.js';
import { pushRoutes } from './routes/push.js';
import { userRoutes } from './routes/users.js';

export function createApp(db: Db) {
  const app = new Hono();

  app.use('*', logger());
  app.use('/api/*', cors({ origin: env.webOrigin, credentials: true }));
  app.use('/auth/*', cors({ origin: env.webOrigin, credentials: true }));

  app.get('/health', (c) => c.json({ ok: true, service: 'janis-api' }));

  app.route('/v1', v1Routes(db)); // agent-facing (server-to-server, no CORS)
  app.route('/auth', authRoutes(db));

  const api = new Hono();
  api.route('/agents', agentRoutes(db));
  api.route('/conversations', conversationRoutes(db));
  api.route('/alerts', alertRoutes(db));
  api.route('/rules', ruleRoutes(db));
  api.route('/stream', streamRoutes(db));
  api.route('/push', pushRoutes(db));
  api.route('/users', userRoutes(db));
  app.route('/api', api);

  return app;
}
