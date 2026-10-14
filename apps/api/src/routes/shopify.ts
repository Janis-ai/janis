import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channels, shopifyShops, workspaces } from '../db/schema.js';
import { invalidateChannelCache } from '../lib/channels.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import {
  bindShop,
  ensureShopForSession,
  handleShopifyWebhook,
  shopBilling,
  shopifyAppConfigured,
  startBillingSubscription,
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

  // Storefront loader — the theme app extension drops
  //   <script src="/api/shopify/storefront.js?s=<shop>">
  // on every page; we resolve shop → bound agent → its Bubble channel and
  // emit the widget.js bootstrap. Deliberately a silent no-op until the
  // merchant links (or if the channel was deleted) — a script 404/500 on
  // a storefront is worse than no bubble.
  app.get('/storefront.js', async (c) => {
    const js = (body: string) =>
      c.body(body, 200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=60',
      });
    const noop = () => js('/* janis: no storefront widget for this shop */');
    const shop = (c.req.query('s') ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return noop();
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, shop))
      .limit(1);
    if (row?.state !== 'linked' || !row.agentId) return noop();
    let chans = await db
      .select({ id: channels.id, credentials: channels.credentials })
      .from(channels)
      .where(and(eq(channels.agentId, row.agentId), eq(channels.kind, 'webchat')));
    // Internal test-chat channels never serve a storefront.
    let chan = chans.find(
      (ch) => !(ch.credentials as { internal?: boolean } | null)?.internal,
    );
    if (!chan && row.workspaceId) {
      // Self-heal: shops bound before the channel auto-create landed (or
      // merchants who deleted their Bubble) get one on first storefront
      // hit instead of silently serving nothing forever.
      [chan] = await db
        .insert(channels)
        .values({
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          kind: 'webchat',
          name: `Shopify — ${shop.replace(/\.myshopify\.com$/, '')}`,
          credentials: {},
        })
        .returning({ id: channels.id, credentials: channels.credentials });
      invalidateChannelCache();
    }
    if (!chan) return noop();
    // Theme-embed overrides — the merchant's Theme Settings values ride
    // as data attributes; widget.js applies them on top of the channel's
    // Bubble config. Whitelisted + validated: the query params are
    // storefront-controlled input.
    const q = c.req.query();
    const attrs: string[] = [];
    const accent = (q.accent ?? '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(accent)) attrs.push(`s.setAttribute('data-janis-accent',${JSON.stringify(accent)});`);
    const position = (q.position ?? '').trim();
    if (position === 'left' || position === 'right')
      attrs.push(`s.setAttribute('data-janis-position',${JSON.stringify(position)});`);
    for (const [param, attr] of [
      ['teaser', 'data-janis-teaser'],
      ['greeting', 'data-janis-greeting'],
    ] as const) {
      const v = (q[param] ?? '').trim().slice(0, 500);
      if (v) attrs.push(`s.setAttribute(${JSON.stringify(attr)},${JSON.stringify(v)});`);
    }
    // Signed-in shopper context — the theme embed passes the logged-in
    // Shopify customer as params. We forward them as an UNSIGNED identity
    // claim (self-reported tier: greeting/prefill, never proof — signing
    // raw params would make this endpoint a forgery oracle). Account-level
    // actions still verify via the order+email pair.
    const cid = (q.cid ?? '').trim();
    const cemail = (q.cemail ?? '').trim().slice(0, 200);
    const cname = (q.cname ?? '').trim().slice(0, 80);
    if (/^\d+$/.test(cid) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cemail)) {
      const claim: Record<string, string> = {};
      if (/^\d+$/.test(cid)) claim.id = `shopify:${cid}`;
      if (cemail) claim.email = cemail;
      if (cname) claim.name = cname;
      attrs.push(`s.setAttribute('data-janis-user',${JSON.stringify(JSON.stringify(claim))});`);
    }
    // Theme → channel sync: non-empty theme overrides persist into the
    // channel's branding so the console Bubble editor shows the same
    // effective values (blank always means "channel default", so absent
    // params never clear a stored value). Write only on change — this
    // endpoint is hot (every storefront page load).
    {
      const branding = ((chan.credentials ?? {}) as { branding?: Record<string, unknown> }).branding ?? {};
      const next: Record<string, unknown> = {};
      // Same validation as the attrs above — junk theme values are dropped,
      // not persisted into channel branding.
      if (/^#[0-9a-fA-F]{6}$/.test(accent)) next.accent = accent;
      if (position === 'left' || position === 'right') next.position = position;
      const teaser = (q.teaser ?? '').trim().slice(0, 200);
      if (teaser) next.teaser_text = teaser;
      const greeting = (q.greeting ?? '').trim().slice(0, 500);
      if (greeting) next.greeting = greeting;
      const changed = Object.entries(next).some(([k, v]) => branding[k] !== v);
      if (changed)
        void db
          .update(channels)
          .set({
            credentials: {
              ...(chan.credentials as Record<string, unknown>),
              branding: { ...branding, ...next },
            },
          } as never)
          .where(eq(channels.id, chan.id))
          .then(() => invalidateChannelCache())
          .catch((e) => console.error('shopify theme→channel sync:', e));
    }
    return js(
      `(function(){var s=document.createElement('script');s.src=${JSON.stringify(
        `${env.apiOrigin}/widget.js`,
      )};s.async=true;s.setAttribute('data-janis-token',${JSON.stringify(chan.id)});s.setAttribute('data-janis-cart','1');${attrs.join('')}document.head.appendChild(s);})();`,
    );
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
        billing: shopBilling(r),
        created_at: r.createdAt,
      })),
    });
  });

  /* ── Billing rail (Phase 5) — the bound shop's AppSubscription drives
     workspaces.plan; Stripe stays untouched on non-shopify workspaces. ── */

  app.get('/billing', async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db
      .select({ billingProvider: workspaces.billingProvider, plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(and(eq(shopifyShops.workspaceId, workspaceId), eq(shopifyShops.state, 'linked')))
      .limit(1);
    return c.json({
      provider: ws?.billingProvider ?? 'stripe',
      plan: ws?.plan ?? 'free',
      shop: row ? { id: row.id, shop: row.shop, subscription: shopBilling(row) } : null,
      test_mode: env.shopifyBillingTest,
    });
  });

  app.post(
    '/billing/start',
    adminOnly,
    zValidator('json', z.object({ plan: z.enum(['starter', 'pro', 'scale']) })),
    async (c) => {
      const { plan } = c.req.valid('json');
      const [row] = await db
        .select()
        .from(shopifyShops)
        .where(and(eq(shopifyShops.workspaceId, c.get('workspaceId')), eq(shopifyShops.state, 'linked')))
        .limit(1);
      if (!row) return c.json({ error: 'no linked Shopify shop — connect a store first' }, 409);
      try {
        const { confirmationUrl } = await startBillingSubscription(db, row, plan);
        return c.json({ confirmation_url: confirmationUrl, test_mode: env.shopifyBillingTest });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : 'billing start failed' }, 502);
      }
    },
  );

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
