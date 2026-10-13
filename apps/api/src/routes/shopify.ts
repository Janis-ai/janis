import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, shopifyShops, workspaces } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import {
  bindShop,
  ensureShopForSession,
  handleShopifyWebhook,
  shopifyAppConfigured,
  signLinkCode,
  unbindShop,
  verifyLinkCode,
  verifySessionToken,
  verifyWebhookHmac,
} from '../lib/shopifyApp.js';

/**
 * Embedded-app endpoints — three trust domains, three mounts:
 *   /api/shopify/*  session-token authed (the Shopify admin iframe — the
 *                   App Bridge JWT is the credential, no cookies)
 *   /shopify/*      provider-signed webhooks (HMAC with the app secret)
 *   api/shopify/*   session-authed console endpoints (the link flow)
 *
 * The api key doubles as the session-token aud and is safe to expose to
 * the storefront; the secret never leaves the API.
 */

async function sessionShop(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ shop: string; token: string } | null> {
  const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return null;
  const claims = verifySessionToken(body.token);
  return claims ? { ...claims, token: body.token } : null;
}

/** /api/shopify — session-token authed (embedded iframe). */
export function shopifyPublicRoutes(db: Db) {
  const app = new Hono();

  // App Bridge bootstrap — the SPA reads the (public) client id for the
  // shopify-api-key meta. 404 when the deployment isn't a Shopify app.
  app.get('/app-config', (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    return c.json({ api_key: env.shopifyAppApiKey });
  });

  // Embedded load — App Bridge hands us a session token; we answer with
  // the shop's link state so the iframe can render connect vs. status.
  app.post('/session', async (c) => {
    if (!shopifyAppConfigured()) return c.json({ error: 'not configured' }, 404);
    const sess = await sessionShop(c);
    if (!sess) return c.json({ error: 'invalid session token' }, 401);

    let row;
    try {
      row = await ensureShopForSession(db, sess.shop, sess.token);
    } catch (err) {
      return c.json({ error: `install failed: ${(err as Error).message}` }, 502);
    }

    const out: Record<string, unknown> = { shop: row.shop, state: row.state };
    if (row.state === 'unlinked') {
      out.link_url = `${env.webOrigin}/shopify-link?code=${signLinkCode(row.id)}`;
    } else if (row.state === 'linked' && row.agentId) {
      const [[agent], [ws]] = await Promise.all([
        db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId)).limit(1),
        db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, row.workspaceId!))
          .limit(1),
      ]);
      out.agent = agent?.name ?? null;
      out.workspace = ws?.name ?? null;
    }
    return c.json(out);
  });

  return app;
}

/** /shopify — provider-signed webhooks. */
export function shopifyWebhookRoutes(db: Db) {
  const app = new Hono();

  app.post('/webhooks', async (c) => {
    const raw = await c.req.text();
    if (!verifyWebhookHmac(raw, c.req.header('x-shopify-hmac-sha256'))) {
      return c.json({ error: 'bad signature' }, 401);
    }
    const shop = c.req.header('x-shopify-shop-domain') ?? '';
    const topic = c.req.header('x-shopify-topic') ?? '';
    const payload = (JSON.parse(raw || '{}') as Record<string, unknown>) ?? {};
    try {
      await handleShopifyWebhook(db, shop, topic, payload);
    } catch (err) {
      // Still 200 after verified receipt — a handler bug is ours to fix,
      // not Shopify's to retry into a webhook-disable loop.
      console.error(`shopify webhook ${topic} ${shop}:`, err);
    }
    return c.json({ ok: true });
  });

  return app;
}

/** api/shopify — console-authed link management. */
export function shopifyApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // Shops bound to this workspace (the link flow + future settings UI).
  app.get('/shops', async (c) => {
    const rows = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.workspaceId, c.get('workspaceId')));
    return c.json({
      shops: rows.map((r) => ({
        id: r.id,
        shop: r.shop,
        agent_id: r.agentId,
        state: r.state,
        created_at: r.createdAt,
      })),
    });
  });

  // What the link-code points at — the link page shows the shop domain
  // before the admin picks an agent to serve it.
  app.get('/link-info', adminOnly, async (c) => {
    const v = verifyLinkCode(c.req.query('code') ?? '');
    if (!v) return c.json({ error: 'invalid or expired link code' }, 400);
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, v.shopId)).limit(1);
    if (!row) return c.json({ error: 'shop not found' }, 404);
    return c.json({
      shop: row.shop,
      state: row.state,
      // An already-bound shop re-linking needs a conscious confirm in the UI.
      bound_agent_id: row.agentId,
    });
  });

  app.post(
    '/link',
    adminOnly,
    zValidator('json', z.object({ code: z.string(), agent_id: z.string() })),
    async (c) => {
      const { code, agent_id } = c.req.valid('json');
      const v = verifyLinkCode(code);
      if (!v) return c.json({ error: 'invalid or expired link code' }, 400);
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(eq(shopifyShops.id, v.shopId))
        .limit(1);
      if (!row) return c.json({ error: 'shop not found' }, 404);
      if (!row.accessTokenEnc) {
        return c.json({ error: 'shop has no install token — reload the app in Shopify admin first' }, 409);
      }
      const workspaceId = c.get('workspaceId');
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agent_id), eq(agents.workspaceId, workspaceId)))
        .limit(1);
      if (!agent) return c.json({ error: 'agent not found' }, 404);

      await bindShop(db, row, { workspaceId, agentId: agent_id });
      return c.json({ ok: true, shop: row.shop });
    },
  );

  app.post(
    '/unlink',
    adminOnly,
    zValidator('json', z.object({ shop_id: z.string() })),
    async (c) => {
      const { shop_id } = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(
          and(eq(shopifyShops.id, shop_id), eq(shopifyShops.workspaceId, c.get('workspaceId'))),
        )
        .limit(1);
      if (!row) return c.json({ error: 'shop not found' }, 404);
      await unbindShop(db, row);
      return c.json({ ok: true });
    },
  );

  return app;
}
