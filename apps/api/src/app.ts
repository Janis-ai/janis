import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
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
import { uploadRoutes } from './routes/uploads.js';
import { savedReplyRoutes } from './routes/savedReplies.js';
import { searchRoutes } from './routes/search.js';
import { digestRoutes } from './routes/digests.js';
import { slackApiRoutes, slackPublicRoutes } from './routes/slack.js';
import { channelApiRoutes, channelWebhookRoutes } from './routes/channels.js';
import { metaApiRoutes } from './routes/meta.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { billingRoutes, stripeWebhookRoutes } from './routes/billing.js';
import { workspaceRoutes } from './routes/workspace.js';

export function createApp(db: Db) {
  const app = new Hono();

  app.use('*', logger());
  // Echo back trusted origins (required for credentialed CORS). Allows the
  // configured web origin plus any localhost/127.0.0.1 port — covers dev
  // proxies like the IDE browser preview.
  const corsOrigin = (origin: string) =>
    origin === env.webOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : '';
  app.use('/api/*', cors({ origin: corsOrigin, credentials: true }));
  app.use('/auth/*', cors({ origin: corsOrigin, credentials: true }));

  app.get('/health', (c) => c.json({ ok: true, service: 'janis-api' }));

  app.route('/v1', v1Routes(db)); // agent-facing (server-to-server, no CORS)
  app.route('/auth', authRoutes(db));
  app.route('/slack', slackPublicRoutes(db)); // Slack-signed (oauth/events/interactions)
  app.route('/channels', channelWebhookRoutes(db)); // Meta webhooks (app-secret signed)
  app.route('/billing/stripe-webhook', stripeWebhookRoutes(db)); // Stripe-signed

  const api = new Hono();
  api.route('/agents', agentRoutes(db));
  api.route('/conversations', conversationRoutes(db));
  api.route('/alerts', alertRoutes(db));
  api.route('/rules', ruleRoutes(db));
  api.route('/stream', streamRoutes(db));
  api.route('/push', pushRoutes(db));
  api.route('/users', userRoutes(db));
  api.route('/uploads', uploadRoutes(db));
  api.route('/saved-replies', savedReplyRoutes(db));
  api.route('/search', searchRoutes(db));
  api.route('/digests', digestRoutes(db));
  api.route('/slack', slackApiRoutes(db));
  api.route('/channels', channelApiRoutes(db));
  api.route('/meta', metaApiRoutes(db));
  api.route('/onboarding', onboardingRoutes(db));
  api.route('/billing', billingRoutes(db));
  api.route('/workspace', workspaceRoutes(db));
  app.route('/api', api);

  app.use('/uploads/*', serveStatic({ root: './' }));

  // Single-origin deploys: serve the built web app when present
  // (src/app.ts and dist/app.js both resolve to apps/web/dist).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const indexHtml = existsSync(join(webDist, 'index.html'))
    ? readFileSync(join(webDist, 'index.html'), 'utf8')
    : null;
  if (indexHtml) {
    app.use('/*', serveStatic({ root: webDist }));
    app.get('*', (c) => {
      // Unknown API-ish paths should 404, not render the SPA
      // (/channels is a web page; only /channels/meta/* is an API route)
      if (/^\/(api|auth|v1|slack|billing|uploads)(\/|$)/.test(c.req.path) ||
          /^\/channels\/meta(\/|$)/.test(c.req.path)) {
        return c.notFound();
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
