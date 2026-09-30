import { Hono } from 'hono';
import { env } from '../env.js';
import { opsAlert } from '../lib/opsAlert.js';

/**
 * Ops-alert receiver — Cloud Monitoring notification channels can't post
 * straight to Slack without installing Google's Slack app, so a webhook
 * channel points here and we repost. Auth is a shared token on the query
 * string (GCP webhook channels have no signing mechanism).
 */
export function opsRoutes() {
  const app = new Hono();

  app.post('/alert', async (c) => {
    if (!env.opsAlertToken || c.req.query('token') !== env.opsAlertToken)
      return c.text('invalid token', 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      incident?: {
        summary?: string;
        policy_name?: string;
        state?: string;
        condition_name?: string;
        resource?: { display_name?: string };
        url?: string;
      };
    };
    const i = body.incident;
    const text = i
      ? `🚨 janis [${i.state ?? '?'}] ${i.summary ?? i.policy_name ?? 'incident'}` +
        (i.url ? ` — ${i.url}` : '')
      : `🚨 janis alert: ${JSON.stringify(body).slice(0, 400)}`;
    opsAlert(text);
    return c.json({ ok: true });
  });

  return app;
}
