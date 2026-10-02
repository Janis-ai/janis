import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { HTTPException } from 'hono/http-exception';
import { eq, sql } from 'drizzle-orm';
import { sweeperLocks } from './db/schema.js';
import type { Db } from './db/client.js';
import { env } from './env.js';
import { reportError } from './lib/errorReporting.js';
import { rateLimit, dbRateLimit } from './lib/rateLimit.js';
import { getUpload } from './lib/uploads.js';
import { authRoutes } from './routes/auth.js';
import { v1Routes } from './routes/v1.js';
import { agentRoutes } from './routes/agents.js';
import { conversationRoutes } from './routes/conversations.js';
import { contactRoutes } from './routes/contacts.js';
import { listRoutes } from './routes/lists.js';
import { suppressionRoutes } from './routes/suppressions.js';
import { campaignRoutes } from './routes/campaigns.js';
import { actionRoutes } from './routes/actions.js';
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
import { errorReportIngest, errorReportRoutes, recordApiError } from './routes/errorReports.js';
import { slackApiRoutes, slackPublicRoutes } from './routes/slack.js';
import { channelApiRoutes, channelWebhookRoutes } from './routes/channels.js';
import { metaApiRoutes, metaPublicRoutes } from './routes/meta.js';
import { gmailApiRoutes, gmailPublicRoutes } from './routes/gmail.js';
import { outlookApiRoutes, outlookPublicRoutes } from './routes/outlook.js';
import { voiceRoutes } from './routes/voice.js';
import { smsRoutes } from './routes/sms.js';
import { articleRoutes, helpPublicRoutes } from './routes/helpCenter.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { toolTemplateRoutes } from './routes/toolTemplates.js';
import { billingRoutes, stripeWebhookRoutes } from './routes/billing.js';
import { PLANS } from './lib/plans.js';
import { workspaceRoutes } from './routes/workspace.js';
import { workosRoutes } from './routes/workos.js';
import { enrollRoutes } from './routes/enroll.js';
import { eventRoutes } from './routes/events.js';
import { opsRoutes } from './routes/ops.js';
import { crmRoutes } from './routes/crm.js';
import { viewRoutes } from './routes/views.js';
import { trackRoutes } from './routes/track.js';
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

  // Public status probe — db connectivity + background-work liveness. The
  // sweeper rewrites its leader lock's expires_at every interval, so a
  // non-expired lock means background work is alive somewhere.
  app.get('/status', async (c) => {
    const checks: Record<string, 'ok' | 'degraded'> = {};
    try {
      await db.execute(sql`select 1`);
      checks.db = 'ok';
    } catch {
      checks.db = 'degraded';
    }
    try {
      const [lock] = await db
        .select({ expiresAt: sweeperLocks.expiresAt })
        .from(sweeperLocks)
        .where(eq(sweeperLocks.name, 'sweeper'))
        .limit(1);
      checks.background = lock && lock.expiresAt > new Date() ? 'ok' : 'degraded';
    } catch {
      checks.background = 'degraded';
    }
    const ok = checks.db === 'ok' && checks.background === 'ok';
    return c.json({ ok, checks, ts: new Date().toISOString() }, ok ? 200 : 503);
  });

  // Public plan catalog — the landing page's pricing cards read this so the
  // site can never drift from what billing actually charges.
  app.get('/api/plans', (c) => {
    return c.json({
      plans: Object.entries(PLANS)
        .filter(([, p]) => !p.hidden)
        .map(([key, p]) => ({
          key,
          name: p.name,
          base_cents: p.baseCents,
          included_messages: p.includedMessages,
          overage_per_1k_cents: p.overagePer1kCents,
          yearly_available: !!env.stripeYearlyPrices[key],
        })),
      trial_days: env.trialDays,
    });
  });

  // Rate limits on public/abuse-prone surfaces. Generous ceilings on signed
  // webhooks (Meta/Slack/Stripe retry in bursts; signature checks still apply);
  // strict on credential endpoints. In-memory limits are per-instance ceilings
  // (Cloud Run runs up to MAX_INSTANCES); the money paths — login, chat writes,
  // chat uploads — use the Postgres limiter so caps hold across instances and,
  // for chat, across IPs rotated against a single channel token.
  app.use('/v1/*', rateLimit({ scope: 'v1', windowMs: 60_000, max: 300 }));
  app.use('/auth/login', dbRateLimit(db, { scope: 'login', windowMs: 60_000, max: 10 }));
  app.use('/slack/events', rateLimit({ scope: 'slack', windowMs: 60_000, max: 120 }));
  app.use('/slack/interactions', rateLimit({ scope: 'slack', windowMs: 60_000, max: 120 }));
  app.use('/channels/meta/*', rateLimit({ scope: 'meta', windowMs: 60_000, max: 300 }));
  app.use('/channels/email/*', rateLimit({ scope: 'email', windowMs: 60_000, max: 300 }));
  app.use('/gmail/*', rateLimit({ scope: 'gmail', windowMs: 60_000, max: 60 }));
  app.use('/messenger/*', rateLimit({ scope: 'meta', windowMs: 60_000, max: 300 }));
  app.use('/meta/*', rateLimit({ scope: 'meta-cb', windowMs: 60_000, max: 60 }));
  app.use('/billing/stripe-webhook', rateLimit({ scope: 'stripe', windowMs: 60_000, max: 60 }));
  // Web-chat: visitors poll while the widget is open (~20/min); posts are
  // stricter. The per-IP write cap stops a single source; the DB-backed
  // per-token caps stop a distributed flood against one channel — that's the
  // path that burns JANIS_LLM_API_KEY on every inbound message.
  app.use('/chat/*', rateLimit({ scope: 'chat-read', windowMs: 60_000, max: 120, methods: ['GET'] }));
  app.use('/chat/*', rateLimit({ scope: 'chat-write', windowMs: 60_000, max: 30, methods: ['POST'] }));
  app.use('/chat/:token/messages', dbRateLimit(db, {
    scope: 'chat-token-write',
    windowMs: 3_600_000,
    max: env.chatTokenHourlyMax,
    methods: ['POST'],
    key: (c) => c.req.param('token') ?? 'unknown',
  }));
  app.use('/chat/:token/uploads', dbRateLimit(db, {
    scope: 'chat-token-upload',
    windowMs: 3_600_000,
    max: env.chatTokenUploadHourlyMax,
    methods: ['POST'],
    key: (c) => c.req.param('token') ?? 'unknown',
  }));
  // Dictation burns OpenAI per call — same per-token hourly budget as uploads.
  app.use('/chat/:token/transcribe', dbRateLimit(db, {
    scope: 'chat-token-transcribe',
    windowMs: 3_600_000,
    max: env.chatTokenUploadHourlyMax,
    methods: ['POST'],
    key: (c) => c.req.param('token') ?? 'unknown',
  }));
  // Public read surfaces — in-memory ceilings are enough here (scrape
  // deterrence, not spend protection).
  app.use('/api/help/*', rateLimit({ scope: 'help', windowMs: 60_000, max: 120 }));
  app.use('/uploads/*', rateLimit({ scope: 'uploads', windowMs: 60_000, max: 120 }));

  app.route('/v1', v1Routes(db)); // agent-facing (server-to-server, no CORS)
  app.route('/auth', authRoutes(db));
  app.route('/slack', slackPublicRoutes(db)); // Slack-signed (oauth/events/interactions)
  app.route('/channels', channelWebhookRoutes(db)); // Meta webhooks (app-secret signed)
  app.route('/billing/stripe-webhook', stripeWebhookRoutes(db)); // Stripe-signed
  app.route('/chat', webchatRoutes(db)); // embeddable web-chat widget
  app.route('/messenger', legacyWebhookRoutes(db)); // legacy Meta app path (webhook.janis.ai)
  app.route('/meta', metaPublicRoutes(db)); // Meta-signed: data-deletion + deauthorize callbacks
  app.route('/gmail', gmailPublicRoutes(db));
  app.route('/outlook', outlookPublicRoutes(db)); // MS-signed-token OAuth + Graph push // signed-token OAuth start/callback — no session
  app.use('/voice/*', rateLimit({ scope: 'voice', windowMs: 60_000, max: 120 }));
  app.route('/voice', voiceRoutes(db)); // Twilio-signed voice webhooks
  app.use('/sms/*', rateLimit({ scope: 'sms', windowMs: 60_000, max: 120 }));
  app.route('/sms', smsRoutes(db)); // Twilio-signed messaging webhooks
  app.route('/api/help', helpPublicRoutes(db)); // public help center — published articles only
  // Legacy npm-SDK transcript/detectIntent API (api.janis.ai) — clientkey-auth'd.
  app.use('/api/v1/*', rateLimit({ scope: 'legacy-api', windowMs: 60_000, max: 300 }));
  app.route('/api/v1', legacyApiRoutes(db));

  // WorkOS Directory Sync webhooks (SCIM provisioning) — HMAC-signed.
  app.use('/workos/*', rateLimit({ scope: 'workos', windowMs: 60_000, max: 120 }));
  app.route('/workos', workosRoutes(db));

  // Campaign enrollment webhooks — secret-URL tokens, per-token DB cap inside.
  app.use('/enroll/*', rateLimit({ scope: 'enroll', windowMs: 60_000, max: 120 }));
  app.route('/enroll', enrollRoutes(db));

  // Conversion-event webhooks — same secret-URL pattern, workspace-scoped.
  app.use('/events/*', rateLimit({ scope: 'events', windowMs: 60_000, max: 120 }));
  app.route('/events', eventRoutes(db));

  // Ops alerting — Cloud Monitoring webhook channel posts incidents here;
  // shared-token auth, forwarded to the ops Slack webhook.
  app.use('/ops/*', rateLimit({ scope: 'ops', windowMs: 60_000, max: 60 }));
  app.route('/ops', opsRoutes());

  // Embed script for the web-chat widget — plain JS, cacheable. Read once at
  // boot in production; re-read per request in dev so widget edits don't
  // need an API restart (tsx watch doesn't watch public/).
  const widgetPath = fileURLToPath(new URL('../public/widget.js', import.meta.url));
  const widgetJs = process.env.NODE_ENV === 'production' ? readFileSync(widgetPath, 'utf8') : null;
  app.get('/widget.js', (c) =>
    c.body(widgetJs ?? readFileSync(widgetPath, 'utf8'), 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    }),
  );

  // First-party echo for the demo concierge's gated propose_refund tool —
  // returns the caller's own args so approve-and-run has something real to
  // show without sending demo data to a third party. No storage, no secrets.
  app.use('/demo/*', rateLimit({ scope: 'demo', windowMs: 60_000, max: 30, methods: ['POST'] }));
  app.post('/demo/echo', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > 8192) return c.json({ error: 'payload too large' }, 413);
    const body = await c.req.json().catch(() => null);
    return c.json({ ok: true, received: body });
  });

  const api = new Hono();
  api.route('/agents', agentRoutes(db));
  api.route('/tool-templates', toolTemplateRoutes(db));
  api.route('/conversations', conversationRoutes(db));
  api.route('/contacts', contactRoutes(db));
  api.route('/lists', listRoutes(db));
  api.route('/suppressions', suppressionRoutes(db));
  api.route('/crm', crmRoutes(db));
  api.route('/campaigns', campaignRoutes(db));
  api.route('/actions', actionRoutes(db));
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
  api.route('/articles', articleRoutes(db));
  api.route('/slack', slackApiRoutes(db));
  api.route('/channels', channelApiRoutes(db));
  api.route('/meta', metaApiRoutes(db));
  api.route('/gmail', gmailApiRoutes(db));
  api.route('/outlook', outlookApiRoutes(db));
  api.route('/onboarding', onboardingRoutes(db));
  api.route('/billing', billingRoutes(db));
  api.route('/workspace', workspaceRoutes(db));
  api.route('/views', viewRoutes(db));
  api.route('/track', trackRoutes(db));
  api.route('/error-reports', errorReportRoutes(db));
  app.route('/api', api);
  // Public ingest for client error bundles — errors happen pre-login too.
  app.route('/api/error-report', errorReportIngest(db));

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
  let indexHtml = existsSync(join(webDist, 'index.html'))
    ? readFileSync(join(webDist, 'index.html'), 'utf8')
    : null;
  if (indexHtml && env.gaMeasurementId) {
    const id = env.gaMeasurementId.replace(/[^A-Z0-9-]/gi, '');
    if (id) {
      const ga =
        `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
        `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${id}');</script>`;
      indexHtml = indexHtml.replace('</head>', `${ga}</head>`);
    }
  }
  if (indexHtml) {
    // The static middleware serves index.html from disk for `/` — return the
    // mutated copy (GA injection happens in-memory, above).
    app.get('/', (c) => c.html(indexHtml));
    app.use('/*', serveStatic({ root: webDist }));
    app.get('*', async (c) => {
      // Unknown API-ish paths should 404, not render the SPA
      // (/channels and /billing are web pages; only /channels/meta/* and
      // /billing/stripe-webhook are API routes)
      if (/^\/(api|auth|v1|slack|uploads|chat|messenger)(\/|$)/.test(c.req.path) ||
          /^\/widget\.js$/.test(c.req.path) ||
          /^\/channels\/meta(\/|$)/.test(c.req.path) ||
          /^\/billing\/stripe-webhook(\/|$)/.test(c.req.path)) {
        return c.notFound();
      }
      // Public help-center pages get real <title>/meta for crawlers —
      // the SPA can't set them until JS runs, and Google barely waits.
      const helpMatch = c.req.path.match(/^\/help\/([0-9a-f-]{36})(?:\/([a-z0-9-]+))?$/i);
      if (helpMatch) {
        const [, agentId, key] = helpMatch;
        try {
          const { helpArticles, agents } = await import('./db/schema.js');
          const { and, eq } = await import('drizzle-orm');
          const [agent] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);
          if (agent) {
            let title = `${agent.name} Help Center`;
            let desc = `Help articles and answers from ${agent.name}.`;
            if (key) {
              const byId = /^[0-9a-f-]{36}$/i.test(key);
              const [a] = await db
                .select()
                .from(helpArticles)
                .where(
                  and(
                    byId ? eq(helpArticles.id, key) : eq(helpArticles.slug, key),
                    eq(helpArticles.agentId, agentId),
                    eq(helpArticles.status, 'published'),
                  ),
                )
                .limit(1);
              if (a) {
                title = a.seoTitle ?? `${a.title} — ${agent.name}`;
                desc = a.seoDescription ?? a.body.slice(0, 200).replace(/\s+/g, ' ').trim();
              }
            }
            const esc = (s: string) =>
              s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const head =
              `<title>${esc(title)}</title>` +
              `<meta name="description" content="${esc(desc)}">` +
              `<meta property="og:title" content="${esc(title)}">` +
              `<meta property="og:description" content="${esc(desc)}">` +
              `<meta property="og:type" content="article">`;
            const html = indexHtml
              .replace(/<meta name="description"[^>]*>/, '')
              .replace(/<title>[^<]*<\/title>/, head);
            return c.html(html);
          }
        } catch {
          // fall through to the plain SPA on any lookup error
        }
      }
      return c.html(indexHtml);
    });
  }

  // Report unexpected errors to Cloud Error Reporting; HTTPException keeps its status.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    reportError(err, c);
    recordApiError(db, err, c);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
