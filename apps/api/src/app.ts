import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/client.js';
import { env } from './env.js';
import { reportError } from './lib/errorReporting.js';
import { rateLimit } from './lib/rateLimit.js';
import { getUpload } from './lib/uploads.js';
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
import { reportRoutes } from './routes/reports.js';
import { slackApiRoutes, slackPublicRoutes } from './routes/slack.js';
import { channelApiRoutes, channelWebhookRoutes } from './routes/channels.js';
import { metaApiRoutes } from './routes/meta.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { billingRoutes, stripeWebhookRoutes } from './routes/billing.js';
import { workspaceRoutes } from './routes/workspace.js';
import { webchatRoutes } from './routes/webchat.js';
import { legacyWebhookRoutes } from './routes/legacy.js';
import { legacyApiRoutes } from './routes/legacyApi.js';

export function createApp(db: Db) {
  const app = new Hono();

  app.use('*', logger());
  // Echo back trusted origins (required for credentialed CORS). Allows the
  // configured web origin plus any localhost/127.0.0.1 port — covers dev
  // proxies like the IDE browser preview. An Origin matching the request's
  // Host is same-origin by definition — covers both the mapped custom domain
  // and the raw run.app URL serving the same app.
  const corsOrigin = (origin: string, c: { req: { header: (n: string) => string | undefined } }) => {
    if (origin === env.webOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return origin;
    }
    try {
      if (new URL(origin).host === c.req.header('host')) return origin;
    } catch {
      // malformed origin — fall through to deny
    }
    return '';
  };
  app.use('/api/*', cors({ origin: corsOrigin, credentials: true }));
  app.use('/auth/*', cors({ origin: corsOrigin, credentials: true }));
  // The web-chat widget is embedded on customer sites — fully public CORS;
  // the channel id is the only credential.
  app.use('/chat/*', cors({ origin: '*' }));

  app.get('/health', (c) => c.json({ ok: true, service: 'janis-api' }));

  // Rate limits on public/abuse-prone surfaces. Generous ceilings on signed
  // webhooks (Meta/Slack/Stripe retry in bursts; signature checks still apply);
  // strict on credential endpoints.
  app.use('/v1/*', rateLimit({ scope: 'v1', windowMs: 60_000, max: 300 }));
  app.use('/auth/login', rateLimit({ scope: 'login', windowMs: 60_000, max: 10 }));
  app.use('/slack/events', rateLimit({ scope: 'slack', windowMs: 60_000, max: 120 }));
  app.use('/slack/interactions', rateLimit({ scope: 'slack', windowMs: 60_000, max: 120 }));
  app.use('/channels/meta/*', rateLimit({ scope: 'meta', windowMs: 60_000, max: 300 }));
  app.use('/messenger/*', rateLimit({ scope: 'meta', windowMs: 60_000, max: 300 }));
  app.use('/billing/stripe-webhook', rateLimit({ scope: 'stripe', windowMs: 60_000, max: 60 }));
  // Web-chat: visitors poll while the widget is open (~20/min); posts are stricter.
  app.use('/chat/*', rateLimit({ scope: 'chat-read', windowMs: 60_000, max: 120, methods: ['GET'] }));
  app.use('/chat/*', rateLimit({ scope: 'chat-write', windowMs: 60_000, max: 30, methods: ['POST'] }));

  app.route('/v1', v1Routes(db)); // agent-facing (server-to-server, no CORS)
  app.route('/auth', authRoutes(db));
  app.route('/slack', slackPublicRoutes(db)); // Slack-signed (oauth/events/interactions)
  app.route('/channels', channelWebhookRoutes(db)); // Meta webhooks (app-secret signed)
  app.route('/billing/stripe-webhook', stripeWebhookRoutes(db)); // Stripe-signed
  app.route('/chat', webchatRoutes(db)); // embeddable web-chat widget
  app.route('/messenger', legacyWebhookRoutes(db)); // legacy Meta app path (webhook.janis.ai)
  // Legacy npm-SDK transcript/detectIntent API (api.janis.ai) — clientkey-auth'd.
  app.use('/api/v1/*', rateLimit({ scope: 'legacy-api', windowMs: 60_000, max: 300 }));
  app.route('/api/v1', legacyApiRoutes(db));

  // Embed script for the web-chat widget — plain JS, cacheable.
  const widgetJs = readFileSync(
    fileURLToPath(new URL('../public/widget.js', import.meta.url)),
    'utf8',
  );
  app.get('/widget.js', (c) =>
    c.body(widgetJs, 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    }),
  );

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
  api.route('/reports', reportRoutes(db));
  api.route('/slack', slackApiRoutes(db));
  api.route('/channels', channelApiRoutes(db));
  api.route('/meta', metaApiRoutes(db));
  api.route('/onboarding', onboardingRoutes(db));
  api.route('/billing', billingRoutes(db));
  api.route('/workspace', workspaceRoutes(db));
  app.route('/api', api);

  // Uploaded attachments are stored in Postgres (durable across deploys);
  // fall through to disk for files written before the DB store existed.
  app.get('/uploads/:name', async (c, next) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) return c.notFound();
    const row = await getUpload(db, name).catch(() => undefined);
    if (!row) return next();
    return c.body(new Uint8Array(row.data), 200, {
      'content-type': row.type,
      'content-length': String(row.size),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `inline; filename="${row.name.replace(/["\\]/g, '_')}"`,
    });
  });
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
      // (/channels and /billing are web pages; only /channels/meta/* and
      // /billing/stripe-webhook are API routes)
      if (/^\/(api|auth|v1|slack|uploads|chat|messenger)(\/|$)/.test(c.req.path) ||
          /^\/widget\.js$/.test(c.req.path) ||
          /^\/channels\/meta(\/|$)/.test(c.req.path) ||
          /^\/billing\/stripe-webhook(\/|$)/.test(c.req.path)) {
        return c.notFound();
      }
      return c.html(indexHtml);
    });
  }

  // Report unexpected errors to Cloud Error Reporting; HTTPException keeps its status.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    reportError(err, c);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
