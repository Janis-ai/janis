import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import {
  agentSecrets,
  agents,
  alerts,
  channels,
  contacts,
  conversations,
  knowledgeFiles,
  memberships,
  messages,
  sessions,
  shopifyShops,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import type { shopifyApiRoutes, shopifyPublicRoutes, shopifyWebhookRoutes } from './shopify.js';

let db: Db;
let app: Hono;
let agentId: string;
let workspaceId: string;
let cookie: string;
// env.ts evaluates at module load — the app creds must be set before the
// route module imports (env loads lazily via secrets.ts), same dance as
// calendly.test.ts.
let publicRoutes: typeof shopifyPublicRoutes;
let apiRoutes: typeof shopifyApiRoutes;
let webhookRoutes: typeof shopifyWebhookRoutes;
let signLinkCode: (shopId: string) => string;

const SHOP = 'dev-store.myshopify.com';
const KEY = 'shp_key';
const SECRET = 'shp_secret';

/** Mint an App Bridge session token (HS256 JWT) for tests. */
const jwt = (payload: Record<string, unknown>, secret = SECRET) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
};
const sessionJwt = (shop = SHOP, overrides: Record<string, unknown> = {}, secret = SECRET) =>
  jwt(
    {
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: KEY,
      sub: '42',
      exp: Math.floor(Date.now() / 1000) + 300,
      nbf: Math.floor(Date.now() / 1000) - 10,
      ...overrides,
    },
    secret,
  );

const hmac = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(raw).digest('base64');
const webhook = (topic: string, payload: unknown, secret = SECRET, shop = SHOP) => {
  const raw = JSON.stringify(payload);
  return app.request('/shopify/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac(raw, secret),
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shop,
    },
    body: raw,
  });
};

const stubShopifyApi = (
  opts: {
    token?: string;
    scope?: string;
    failExchange?: boolean;
    // Exchange returns an expiring pair (public-app installs always get one).
    expires_in?: number;
    refresh_token?: string;
    // Reply to grant_type=refresh_token; may rotate the refresh token.
    refreshReply?: { access_token: string; refresh_token?: string; expires_in?: number };
    onTokenRequest?: (fields: Record<string, unknown>) => void;
  } = {},
) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/admin/oauth/access_token')) {
        // Exchange posts JSON; the refresh grant posts form-encoded fields.
        const body = init?.body;
        const fields: Record<string, unknown> =
          body instanceof URLSearchParams
            ? Object.fromEntries(body)
            : typeof body === 'string'
              ? (JSON.parse(body) as Record<string, unknown>)
              : {};
        opts.onTokenRequest?.(fields);
        if (fields.grant_type === 'refresh_token') {
          return Promise.resolve(
            Response.json(opts.refreshReply ?? { access_token: 'refreshed_tok', expires_in: 3600 }),
          );
        }
        if (opts.failExchange)
          return Promise.resolve(new Response('{"error":"server_error"}', { status: 500 }));
        return Promise.resolve(
          Response.json({
            access_token: opts.token ?? 'shpat_offline',
            scope: opts.scope ?? 'read_orders,write_orders,read_products,read_customers',
            ...(opts.expires_in
              ? { expires_in: opts.expires_in, refresh_token: opts.refresh_token ?? 'rt_1' }
              : {}),
          }),
        );
      }
      if (url.includes('graphql.json')) {
        return Promise.resolve(
          Response.json({
            data: {
              webhookSubscriptions: { nodes: [] },
              webhookSubscriptionCreate: {
                webhookSubscription: { id: 'wh1' },
                userErrors: [],
              },
            },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );

beforeAll(async () => {
  process.env.SHOPIFY_APP_API_KEY = KEY;
  process.env.SHOPIFY_APP_API_SECRET = SECRET;
  const mod = await import('./shopify.js');
  publicRoutes = mod.shopifyPublicRoutes;
  apiRoutes = mod.shopifyApiRoutes;
  webhookRoutes = mod.shopifyWebhookRoutes;
  signLinkCode = (await import('../lib/shopifyApp.js')).signLinkCode;

  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/shopify', publicRoutes(db))
    .route('/api/shopify', apiRoutes(db))
    .route('/shopify', webhookRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  workspaceId = ws.id;
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  agentId = agent.id;

  const [u] = await db.insert(users).values({ email: 'a@x.test', name: 'a' }).returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  cookie = `${SESSION_COOKIE}=${token}`;
});

afterEach(() => vi.unstubAllGlobals());

const postSession = (token: string) =>
  app.request('/api/shopify/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

const linkCodeFor = async (): Promise<string> => {
  await postSession(sessionJwt()); // idempotent install/self-heal
  const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
  return signLinkCode(row.id);
};

describe('shopify embedded app — session', () => {
  it('rejects a token signed with the wrong secret', async () => {
    const res = await postSession(sessionJwt(SHOP, {}, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('rejects a token with a foreign aud', async () => {
    const res = await postSession(sessionJwt(SHOP, { aud: 'other-app' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token pinned to a non-shopify domain', async () => {
    const res = await postSession(
      sessionJwt('evil.com', { iss: 'https://evil.com/admin', dest: 'https://evil.com' }),
    );
    expect(res.status).toBe(401);
  });

  it('installs the shop — token exchange + zero-login provision binds it', async () => {
    stubShopifyApi();
    const res = await postSession(sessionJwt());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shop: string;
      state: string;
      provisioned?: boolean;
      claimed?: boolean;
      claim_url?: string;
    };
    expect(body.shop).toBe(SHOP);
    // First embedded load auto-provisions — the merchant lands on "linked"
    // with no Janis login in the path at all.
    expect(body.state).toBe('linked');
    expect(body.provisioned).toBe(true);
    expect(body.claimed).toBe(false);
    expect(body.claim_url).toContain('/shopify-claim?code=');
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect(row.accessTokenEnc).toBeTruthy();
    expect(row.scopes).toBe('read_orders,write_orders,read_products,read_customers');
    expect(row.provisionedAt).toBeTruthy();
  });

  it('a second embedded load re-exchanges — a scope bump self-heals', async () => {
    stubShopifyApi();
    await postSession(sessionJwt());
    // App version gains write_draft_orders and the merchant re-consents —
    // the next embedded load's exchange returns the expanded grant and the
    // stored token+scopes row updates with no reinstall or manual refresh.
    stubShopifyApi({
      token: 'shpat_v2',
      scope: 'read_orders,write_orders,write_draft_orders,read_products,read_customers',
    });
    const res = await postSession(sessionJwt());
    expect(res.status).toBe(200);
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect(row.scopes).toBe('read_orders,write_orders,write_draft_orders,read_products,read_customers');
    // Lazy import — env.ts must not evaluate before beforeAll sets the creds.
    const { decryptSecret } = await import('../lib/secrets.js');
    expect(decryptSecret(row.accessTokenEnc!)).toBe('shpat_v2');
  });

  it('a failed re-exchange keeps the stored token — the page still loads', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('failshop.myshopify.com'));
    // A transient exchange failure on the next load must degrade to the
    // stored token, not break the embedded page.
    stubShopifyApi({ failExchange: true });
    const res = await postSession(sessionJwt('failshop.myshopify.com'));
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'failshop.myshopify.com'));
    expect(row.accessTokenEnc).toBeTruthy();
  });

  it('a provisioned shop relinks on reinstall — no reprovision', async () => {
    stubShopifyApi();
    // First load provisions and binds; uninstall keeps the binding.
    await postSession(sessionJwt('fresh.myshopify.com'));
    const wsCount = (await db.select({ id: workspaces.id }).from(workspaces)).length;
    await webhook('app/uninstalled', {}, SECRET, 'fresh.myshopify.com');
    let [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'fresh.myshopify.com'));
    expect(row.state).toBe('uninstalled');
    // Reinstall → session exchange restores 'linked' with the SAME binding —
    // the shop must not double-provision a second workspace.
    const res = await postSession(sessionJwt('fresh.myshopify.com'));
    const body = (await res.json()) as { state: string; provisioned?: boolean };
    expect(body.state).toBe('linked');
    [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'fresh.myshopify.com'));
    expect((await db.select({ id: workspaces.id }).from(workspaces)).length).toBe(wsCount);
  });
});

describe('expiring offline tokens (public apps)', () => {
  const decrypt = async (enc: string) => (await import('../lib/secrets.js')).decryptSecret(enc);

  it('exchange sends expiring:1 and persists the refresh pair', async () => {
    let seen: Record<string, unknown> = {};
    stubShopifyApi({
      token: 'tok_a',
      expires_in: 3600,
      refresh_token: 'rt_1',
      onTokenRequest: (f) => {
        seen = f;
      },
    });
    const res = await postSession(sessionJwt('exp.myshopify.com'));
    expect(res.status).toBe(200);
    expect(seen.expiring).toBe(1);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'exp.myshopify.com'));
    expect(row.tokenExpiresAt).toBeTruthy();
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await decrypt(row.refreshTokenEnc!)).toBe('rt_1');
    expect(await decrypt(row.accessTokenEnc!)).toBe('tok_a');
  });

  it('adminToken refreshes an expired token — rotates the refresh token and re-mirrors the agent secret', async () => {
    stubShopifyApi({ expires_in: 3600, refresh_token: 'rt_old', token: 'tok_stale' });
    await postSession(sessionJwt('stale.myshopify.com'));
    const { encryptSecret } = await import('../lib/secrets.js');
    const [row0] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'stale.myshopify.com'));
    await db
      .update(shopifyShops)
      .set({
        workspaceId,
        agentId,
        state: 'linked',
        tokenExpiresAt: new Date(Date.now() - 60_000), // force-expired
      })
      .where(eq(shopifyShops.id, row0.id));

    let refreshFields: Record<string, unknown> = {};
    stubShopifyApi({
      refreshReply: { access_token: 'tok_new', refresh_token: 'rt_new', expires_in: 3600 },
      onTokenRequest: (f) => {
        refreshFields = f;
      },
    });
    const { adminToken } = await import('../lib/shopifyToken.js');
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'stale.myshopify.com'));
    expect(await adminToken(db, row)).toBe('tok_new');
    expect(refreshFields.grant_type).toBe('refresh_token');
    expect(refreshFields.refresh_token).toBe('rt_old');
    expect(refreshFields.client_id).toBe(KEY);

    const [row2] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'stale.myshopify.com'));
    expect(await decrypt(row2.accessTokenEnc!)).toBe('tok_new');
    expect(await decrypt(row2.refreshTokenEnc!)).toBe('rt_new'); // rotation persisted
    expect(row2.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // The linked agent's SHOPIFY_TOKEN secret tracked the refresh — tools
    // can't be stranded on an hour-old token.
    const [sec] = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, 'SHOPIFY_TOKEN')));
    expect(await decrypt(sec.valueEnc)).toBe('tok_new');
    // Hand-linked rows pollute the shared workspace for later tests.
    await db
      .update(shopifyShops)
      .set({ workspaceId: null, agentId: null, state: 'unlinked' })
      .where(eq(shopifyShops.shop, 'stale.myshopify.com'));
  });

  it('a still-valid token returns without a Shopify round-trip', async () => {
    stubShopifyApi({ expires_in: 3600, refresh_token: 'rt_1', token: 'tok_v' });
    await postSession(sessionJwt('valid.myshopify.com'));
    let refreshHits = 0;
    stubShopifyApi({
      onTokenRequest: (f) => {
        if (f.grant_type === 'refresh_token') refreshHits++;
      },
    });
    const { adminToken } = await import('../lib/shopifyToken.js');
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'valid.myshopify.com'));
    expect(await adminToken(db, row)).toBe('tok_v');
    expect(refreshHits).toBe(0);
  });

  it('a legacy non-expiring token is returned as-is (no expiry metadata)', async () => {
    stubShopifyApi(); // no expires_in in the exchange reply
    await postSession(sessionJwt('legacy.myshopify.com'));
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'legacy.myshopify.com'));
    expect(row.tokenExpiresAt).toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
    let refreshHits = 0;
    stubShopifyApi({
      onTokenRequest: (f) => {
        if (f.grant_type === 'refresh_token') refreshHits++;
      },
    });
    const { adminToken } = await import('../lib/shopifyToken.js');
    expect(await adminToken(db, row)).toBe('shpat_offline');
    expect(refreshHits).toBe(0);
  });

  it('uninstall clears the refresh pair with the access token', async () => {
    stubShopifyApi({ expires_in: 3600, refresh_token: 'rt_1' });
    await postSession(sessionJwt('gone.myshopify.com'));
    await webhook('app/uninstalled', {}, SECRET, 'gone.myshopify.com');
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'gone.myshopify.com'));
    expect(row.state).toBe('uninstalled');
    expect(row.accessTokenEnc).toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
    expect(row.tokenExpiresAt).toBeNull();
  });
});

describe('shopify link flow', () => {
  it('link-info resolves the code to the shop', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    const res = await app.request(`/api/shopify/link-info?code=${code}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shop: string }).shop).toBe(SHOP);
  });

  it('a forged code is rejected', async () => {
    const res = await app.request('/api/shopify/link-info?code=forged.sig', {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });

  it('link binds the shop to the agent and mirrors credentials as secrets', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    const res = await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect(row.state).toBe('linked');
    expect(row.agentId).toBe(agentId);
    expect(row.workspaceId).toBe(workspaceId);
    const secrets = await db
      .select({ name: agentSecrets.name })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, agentId));
    expect(secrets.map((s) => s.name).sort()).toEqual(['SHOPIFY_SHOP', 'SHOPIFY_TOKEN']);
    // bind also lands the catalog tool defs — the agent works with no
    // console install step
    const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId));
    const toolNames = ((a.config as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('shopify_lookup_order');
    expect(toolNames).toContain('shopify_cancel_order');
    // Phase 4 — bind also lands the shopify:// knowledge sources
    const kf = await db
      .select({ sourceUrl: knowledgeFiles.sourceUrl })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agentId));
    expect(kf.map((f) => f.sourceUrl).sort()).toEqual([
      'shopify://catalog',
      'shopify://policies',
    ]);
  });

  it('link refuses an agent outside the workspace', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    const res = await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('shopify zero-login provisioning', () => {
  it('first load provisions a hosted agent bound to an ownerless shopify workspace', async () => {
    stubShopifyApi();
    const res = await postSession(sessionJwt('new-shop.myshopify.com'));
    const body = (await res.json()) as { state: string; provisioned?: boolean };
    expect(body.state).toBe('linked');
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'new-shop.myshopify.com'));
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId!));
    expect(ws.ownerUserId).toBeNull();
    expect(ws.billingProvider).toBe('shopify');
    expect((ws.config as { shopify_provisioned?: boolean }).shopify_provisioned).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId!));
    expect(agent.hosted).toBe(true);
    // bindShop did the heavy lifting — secrets + catalog tools + knowledge.
    const secrets = await db
      .select({ name: agentSecrets.name })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, row.agentId!));
    expect(secrets.map((s) => s.name).sort()).toEqual(['SHOPIFY_SHOP', 'SHOPIFY_TOKEN']);
    const kf = await db
      .select({ sourceUrl: knowledgeFiles.sourceUrl })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, row.agentId!));
    expect(kf.map((f) => f.sourceUrl).sort()).toEqual(['shopify://catalog', 'shopify://policies']);
  });

  it('repeat loads keep the same binding — no duplicate workspaces', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('repeat.myshopify.com'));
    const wsCount = (await db.select({ id: workspaces.id }).from(workspaces)).length;
    const res = await postSession(sessionJwt('repeat.myshopify.com'));
    expect(((await res.json()) as { state: string }).state).toBe('linked');
    expect((await db.select({ id: workspaces.id }).from(workspaces)).length).toBe(wsCount);
  });

  it('a deliberate unlink stamps the gate — next load stays on the manual link flow', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('unlink-me.myshopify.com'));
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'unlink-me.myshopify.com'));
    // Rebind to the signed-in workspace so /unlink applies to it.
    const link = await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code: signLinkCode(row.id), agent_id: agentId }),
    });
    expect(link.status).toBe(200);
    const unlink = await app.request('/api/shopify/unlink', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ shop_id: row.id }),
    });
    expect(unlink.status).toBe(200);
    // Next embedded load: still unlinked, manual link flow — no silent rebind.
    const res = await postSession(sessionJwt('unlink-me.myshopify.com'));
    const body = (await res.json()) as { state: string; link_url?: string };
    expect(body.state).toBe('unlinked');
    expect(body.link_url).toContain('/shopify-link?code=');
  });
});

describe('shopify claim', () => {
  const postClaim = (code: string) =>
    app.request('/api/shopify/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code }),
    });

  it('makes the signed-in user admin + owner of the provisioned workspace', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('claim-me.myshopify.com'));
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'claim-me.myshopify.com'));
    const res = await postClaim(signLinkCode(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspace_id: string; agent_id: string };
    expect(body.workspace_id).toBe(row.workspaceId);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId!));
    const [u] = await db.select().from(users).where(eq(users.email, 'a@x.test'));
    expect(ws.ownerUserId).toBe(u.id);
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, u.id), eq(memberships.workspaceId, row.workspaceId!)));
    expect(m.role).toBe('admin');
    // Idempotent — a repeat claim is a no-op, not a membership error.
    expect((await postClaim(signLinkCode(row.id))).status).toBe(200);
  });

  it('rejects a forged claim code', async () => {
    const res = await postClaim('forged.sig');
    expect(res.status).toBe(400);
  });

  it('409s when the shop is not bound to a workspace', async () => {
    const [row] = await db
      .insert(shopifyShops)
      .values({ shop: 'bare.myshopify.com', provisionedAt: new Date() })
      .returning();
    const res = await postClaim(signLinkCode(row.id));
    expect(res.status).toBe(409);
  });
});

describe('shopify webhooks', () => {
  it('rejects a bad signature', async () => {
    const res = await webhook('app/uninstalled', {}, 'wrong');
    expect(res.status).toBe(401);
  });

  it('app/uninstalled scrubs the token and mirrored secrets but keeps the binding', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const res = await webhook('app/uninstalled', { domain: SHOP });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect(row.state).toBe('uninstalled');
    expect(row.accessTokenEnc).toBeNull();
    expect(row.agentId).toBe(agentId); // binding survives → reinstall relinks
    const secrets = await db
      .select({ name: agentSecrets.name })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, agentId));
    expect(secrets.map((s) => s.name)).not.toContain('SHOPIFY_TOKEN');
  });

  it('customers/redact purges the matched contact + its threads', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId, email: 'buyer@x.com', externalIds: { shopify: '777' } })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'chat:1', contactId: contact.id })
      .returning();
    await db.insert(messages).values({ conversationId: conv.id, direction: 'in', text: 'hi' });

    const res = await webhook('customers/redact', {
      customer: { id: 777, email: 'buyer@x.com' },
      orders_to_redact: [1],
    });
    expect(res.status).toBe(200);
    expect(
      (await db.select().from(contacts).where(eq(contacts.id, contact.id))).length,
    ).toBe(0);
    expect(
      (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).length,
    ).toBe(0);
  });

  /** Link SHOP, then plant a contact + open thread — the order-event
   *  tests' shared setup. Email must be unique per test: contact match is
   *  by email, so reuse would attach the note to an earlier test's thread. */
  const linkAndThread = async (email: string) => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId, email })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: `chat:${Math.random()}`, contactId: contact.id })
      .returning();
    return { contact, conv };
  };

  it('orders/create notes the order on the customer thread', async () => {
    const { conv } = await linkAndThread('order@x.com');
    const res = await webhook('orders/create', {
      name: '#1009',
      email: 'order@x.com',
      total_price: '29.95',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const notes = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const note = notes.find(
      (m) => (m.payload as { event?: string })?.event === 'order_event',
    );
    expect(note?.text).toContain('#1009');
    expect(note?.text).toContain('placed');
    expect(note?.text).toContain('USD 29.95');
    expect((note?.payload as { internal?: boolean })?.internal).toBe(true);
  });

  it('orders/create stays silent for buyers who never chatted', async () => {
    await linkAndThread('silent@x.com');
    const res = await webhook('orders/create', {
      name: '#1010',
      email: 'stranger@x.com',
      total_price: '5.00',
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    const notes = await db.select().from(messages);
    expect(notes.filter((m) => m.text?.includes('#1010')).length).toBe(0);
  });

  it('checkouts/update notes the thread once per checkout token', async () => {
    const { conv } = await linkAndThread('checkout@x.com');
    const payload = {
      token: 'chk-tok-1',
      email: 'checkout@x.com',
      total_price: '88.00',
      currency: 'USD',
      line_items: [{ title: 'Wax' }, { title: 'Board' }],
    };
    const res = await webhook('checkouts/update', payload);
    expect(res.status).toBe(200);
    const notes = async () =>
      (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter(
        (m) => (m.payload as { event?: string })?.event === 'checkout_event',
      );
    expect((await notes()).length).toBe(1);
    const note = (await notes())[0];
    expect(note.text).toContain('2 items');
    expect(note.text).toContain('USD 88.00');
    expect((note.payload as { internal?: boolean }).internal).toBe(true);
    expect((note.payload as { checkout?: string }).checkout).toBe('chk-tok-1');
    // checkouts/update refires on every field change — same token must not
    // double-note the thread.
    const res2 = await webhook('checkouts/update', { ...payload, total_price: '88.00' });
    expect(res2.status).toBe(200);
    expect((await notes()).length).toBe(1);
    // A different checkout token is a different checkout — allowed.
    await webhook('checkouts/update', { ...payload, token: 'chk-tok-2' });
    expect((await notes()).length).toBe(2);
  });

  it('products/update pulls the catalog knowledge sync forward', async () => {
    await linkAndThread('prod@x.com');
    const [file] = await db
      .select()
      .from(knowledgeFiles)
      .where(
        and(
          eq(knowledgeFiles.agentId, agentId),
          eq(knowledgeFiles.sourceUrl, 'shopify://catalog'),
        ),
      );
    expect(file).toBeTruthy();
    await db
      .update(knowledgeFiles)
      .set({ nextFetchAt: new Date(Date.now() + 86_400_000) })
      .where(eq(knowledgeFiles.id, file.id));
    const res = await webhook('products/update', { id: 1 });
    expect(res.status).toBe(200);
    const [after] = await db
      .select()
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.id, file.id));
    expect(after.nextFetchAt!.getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('refunds/create notes the thread AND raises a custom alert', async () => {
    const { conv } = await linkAndThread('refund@x.com');
    // Refund payloads carry no email — the handler fetches the order.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/admin/oauth/access_token'))
          return Promise.resolve(Response.json({ access_token: 't', scope: 'read_orders' }));
        if (url.includes('graphql.json')) {
          const body = String(init?.body ?? '');
          if (body.includes('order(id:'))
            return Promise.resolve(
              Response.json({
                data: {
                  order: {
                    name: '#1007',
                    email: 'refund@x.com',
                    currentTotalPriceSet: {
                      shopMoney: { amount: '50.00', currencyCode: 'USD' },
                    },
                  },
                },
              }),
            );
          return Promise.resolve(
            Response.json({
              data: {
                webhookSubscriptions: { nodes: [] },
                webhookSubscriptionCreate: { webhookSubscription: { id: 'w' }, userErrors: [] },
              },
            }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const res = await webhook('refunds/create', { id: 9, order_id: 555 });
    expect(res.status).toBe(200);
    const notes = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const note = notes.find((m) => (m.payload as { event?: string })?.event === 'order_event');
    expect(note?.text).toContain('#1007');
    expect(note?.text).toContain('refunded');
    const [a] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'custom')));
    expect(a?.detail).toContain('#1007');
    expect(a?.status).toBe('open');
  });

  it('shopify://catalog refresh renders store products as knowledge text', async () => {
    await linkAndThread('catalog@x.com');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('graphql.json')) {
          const isCatalog = true;
          void isCatalog;
          return Promise.resolve(
            Response.json({
              data: {
                productsCount: { count: 2 },
                products: {
                  nodes: [
                    {
                      title: 'Ski Wax',
                      handle: 'ski-wax',
                      vendor: 'WaxCo',
                      productType: 'Wax',
                      tags: ['winter'],
                      status: 'ACTIVE',
                      totalInventory: 8,
                      description: 'Fast wax.',
                      priceRangeV2: {
                        minVariantPrice: { amount: '9.95', currencyCode: 'USD' },
                      },
                    },
                  ],
                },
              },
            }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const [file] = await db
      .select()
      .from(knowledgeFiles)
      .where(
        and(
          eq(knowledgeFiles.agentId, agentId),
          eq(knowledgeFiles.sourceUrl, 'shopify://catalog'),
        ),
      );
    // Lazy — env.ts must not evaluate before beforeAll set the app creds.
    const { refreshKnowledgeSource } = await import('../lib/urlSource.js');
    const ok = await refreshKnowledgeSource(db, file);
    expect(ok).toBe(true);
    const [after] = await db
      .select()
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.id, file.id));
    expect(after.status).toBe('ready');
    expect(after.text).toContain('2 active products');
    expect(after.text).toContain('Ski Wax');
    expect(after.text).toContain('https://dev-store.myshopify.com/products/ski-wax');
    expect(after.text).toContain('USD 9.95');
  });
});

describe('storefront loader', () => {
  const storefrontJs = (s: string) =>
    app.request(`/api/shopify/storefront.js?s=${encodeURIComponent(s)}`);

  it('bind creates a storefront Bubble and the loader emits its channel token', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const chans = await db
      .select()
      .from(channels)
      .where(and(eq(channels.agentId, agentId), eq(channels.kind, 'webchat')));
    const external = chans.filter(
      (ch) => !(ch.credentials as { internal?: boolean }).internal,
    );
    expect(external.length).toBe(1);
    expect(external[0].name).toBe('Shopify — dev-store');
    const res = await storefrontJs(SHOP);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const js = await res.text();
    expect(js).toContain('/widget.js');
    expect(js).toContain(external[0].id);
  });

  it('theme-embed settings pass through as validated data attributes', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const res = await app.request(
      `/api/shopify/storefront.js?s=${SHOP}&accent=%23aabbcc&position=left&teaser=Hi!&greeting=Hello&bogus=ignored&accent2=notahex`,
    );
    const js = await res.text();
    expect(js).toContain('data-janis-accent');
    expect(js).toContain('#aabbcc');
    expect(js).toContain('data-janis-position');
    expect(js).toContain('"left"');
    expect(js).toContain('data-janis-teaser');
    expect(js).toContain('data-janis-greeting');
    // unwhitelisted/invalid params never reach the tag
    expect(js).not.toContain('bogus');
    expect(js).not.toContain('notahex');
  });

  it('a re-link reuses the existing Bubble — no duplicate channels', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    const count = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.agentId, agentId), eq(channels.kind, 'webchat')));
    expect(count.length).toBe(1);
  });

  it('no-ops for unknown shops and non-shopify domains', async () => {
    for (const s of ['never-installed.myshopify.com', 'evil.com', 'x.myshopify.com.evil.com']) {
      const res = await storefrontJs(s);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('no storefront widget');
    }
  });

  it('self-heals a missing Bubble — never serves the internal test chat', async () => {
    stubShopifyApi();
    const { hash, preview } = generateApiKey();
    const [agent2] = await db
      .insert(agents)
      .values({ workspaceId, name: 'Bot2', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const [internal] = await db
      .insert(channels)
      .values({
        workspaceId,
        agentId: agent2.id,
        kind: 'webchat',
        name: `Test — ${agent2.name}`,
        credentials: { internal: true },
      })
      .returning();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agent2.id }),
    });
    // bind adds a real Bubble — delete it to simulate a merchant who
    // removed the channel; the loader must recreate, not serve the test
    // chat or go dark
    await db
      .delete(channels)
      .where(
        and(
          eq(channels.agentId, agent2.id),
          eq(channels.kind, 'webchat'),
          eq(channels.name, 'Shopify — dev-store'),
        ),
      );
    const res = await storefrontJs(SHOP);
    const js = await res.text();
    expect(js).toContain('/widget.js');
    expect(js).not.toContain(internal.id);
    // relink back to the primary agent for the tests that follow
    const code2 = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code2, agent_id: agentId }),
    });
  });
});

describe('shopify billing rail', () => {
  const link = async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
  };

  it('start → appSubscriptionCreate → confirmation url; webhook ACTIVE flips the workspace', async () => {
    await link();
    // GraphQL stub answering the subscription mutation.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('graphql.json'))
          return Promise.resolve(
            Response.json({
              data: {
                appSubscriptionCreate: {
                  confirmationUrl: 'https://admin.shopify.com/store/dev-store/charges/123/confirm',
                  appSubscription: { id: 'gid://shopify/AppSubscription/123', status: 'PENDING' },
                  userErrors: [],
                },
              },
            }),
          );
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const res = await app.request('/api/shopify/billing/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plan: 'pro' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmation_url: string };
    expect(body.confirmation_url).toContain('confirm');
    let [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect((row.billing as { subscriptionId?: string }).subscriptionId).toBe(
      'gid://shopify/AppSubscription/123',
    );

    // Merchant approves → app_subscriptions/update ACTIVE.
    const wh = await webhook('app_subscriptions/update', {
      app_subscription: {
        admin_graphql_api_id: 'gid://shopify/AppSubscription/123',
        name: 'Janis Pro',
        status: 'ACTIVE',
      },
    });
    expect(wh.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.plan).toBe('pro');
    expect(ws.billingProvider).toBe('shopify');
    [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect((row.billing as { status?: string }).status).toBe('ACTIVE');
  });

  it('cancel drops a shopify-billed workspace to free — provider stays shopify', async () => {
    await link();
    await db
      .update(workspaces)
      .set({ plan: 'pro', billingProvider: 'shopify' })
      .where(eq(workspaces.id, workspaceId));
    const wh = await webhook('app_subscriptions/update', {
      app_subscription: {
        admin_graphql_api_id: 'gid://shopify/AppSubscription/123',
        name: 'Janis Pro',
        status: 'CANCELLED',
      },
    });
    expect(wh.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.plan).toBe('free');
    expect(ws.billingProvider).toBe('shopify');
  });

  it('a stripe-billed workspace ignores a stray subscription cancel', async () => {
    await link();
    await db
      .update(workspaces)
      .set({ plan: 'pro', billingProvider: 'stripe' })
      .where(eq(workspaces.id, workspaceId));
    await webhook('app_subscriptions/update', {
      app_subscription: { name: 'Janis Pro', status: 'CANCELLED' },
    });
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.plan).toBe('pro'); // stripe rail owns the plan — untouched
  });

  it('GET /billing reports the rail + subscription state', async () => {
    await link();
    const res = await app.request('/api/shopify/billing', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      shop: { shop: string; subscription: { status?: string } };
    };
    expect(body.shop.shop).toBe(SHOP);
    expect(body.shop.subscription.status).toBe('CANCELLED'); // persisted by the prior test
  });

  it('start rejects non-billable plans', async () => {
    const res = await app.request('/api/shopify/billing/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ plan: 'free' }),
    });
    expect(res.status).toBe(400); // zod — free/internal never reach Shopify
  });

  it('charge test mode follows shop.plan.partnerDevelopment — never a global flag', async () => {
    await link();
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    const { startBillingSubscription } = await import('../lib/shopifyApp.js');
    for (const dev of [true, false]) {
      const bodies: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const body = typeof init?.body === 'string' ? init.body : '';
          bodies.push(body);
          if (url.includes('graphql.json') && body.includes('partnerDevelopment'))
            return Promise.resolve(
              Response.json({ data: { shop: { plan: { partnerDevelopment: dev } } } }),
            );
          if (url.includes('graphql.json'))
            return Promise.resolve(
              Response.json({
                data: {
                  appSubscriptionCreate: {
                    confirmationUrl: 'https://admin.shopify.com/store/dev-store/charges/1/confirm',
                    appSubscription: { id: 'gid://shopify/AppSubscription/1', status: 'PENDING' },
                    userErrors: [],
                  },
                },
              }),
            );
          return Promise.resolve(new Response('{}', { status: 404 }));
        }),
      );
      await startBillingSubscription(db, row, 'starter');
      const mutation = bodies.find((b) => b.includes('appSubscriptionCreate'))!;
      expect(mutation).toContain(`test: ${dev}`);
    }
  });
});

describe('app proxy — verified shopper identity', () => {
  // Shopify's app-proxy signature: sorted key=value pairs, concatenated,
  // HMAC-SHA256 hex with the app secret. This mirrors verifyProxySig.
  const proxyUrl = (params: Record<string, string>, secret = SECRET) => {
    const body = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('');
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return `/api/shopify/proxy/session?${new URLSearchParams({ ...params, signature })}`;
  };
  const ts = () => String(Math.floor(Date.now() / 1000));

  it('rejects unsigned and badly-signed requests', async () => {
    expect((await app.request('/api/shopify/proxy/session')).status).toBe(401);
    expect(
      (await app.request(proxyUrl({ shop: SHOP, timestamp: ts() }, 'wrong'))).status,
    ).toBe(401);
    // Valid signature, stale timestamp — replayed URLs die.
    expect(
      (await app.request(proxyUrl({ shop: SHOP, timestamp: '1000000' }))).status,
    ).toBe(401);
  });

  it('returns claim:null for a signed request with no logged-in customer', async () => {
    const res = await app.request(proxyUrl({ shop: SHOP, timestamp: ts() }));
    expect(res.status).toBe(200);
    expect((await res.json()).claim).toBeNull();
  });

  it('mints a channel-signed claim for a Shopify-verified customer', async () => {
    // Link a shop + give the agent a customer-facing webchat channel.
    const PROXY_SHOP = 'proxy-store.myshopify.com';
    const { encryptSecret } = await import('../lib/secrets.js');
    await db.insert(schema.shopifyShops).values({
      shop: PROXY_SHOP,
      state: 'linked',
      agentId,
      workspaceId,
      accessTokenEnc: encryptSecret('shpat_test'),
    });
    const [chan] = await db
      .insert(schema.channels)
      .values({
        workspaceId,
        agentId,
        kind: 'webchat',
        name: 'Proxy Bubble',
        credentials: {},
      })
      .returning();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('graphql.json'))
          return Promise.resolve(
            Response.json({
              data: { customer: { email: 'shopper@store.com', displayName: 'Shop Patron' } },
            }),
          );
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const res = await app.request(
      proxyUrl({ shop: PROXY_SHOP, timestamp: ts(), logged_in_customer_id: '777' }),
    );
    expect(res.status).toBe(200);
    const { claim } = (await res.json()) as { claim: { id: string; email?: string; name?: string; sig: string } | null };
    expect(claim?.id).toBe('shopify:777');
    expect(claim?.email).toBe('shopper@store.com');
    // The claim must verify exactly like a host-signed identify claim —
    // against whichever of the agent's webchat channels minted it (the
    // loader picks the first non-internal one).
    const chans = await db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.agentId, agentId), eq(schema.channels.kind, 'webchat')));
    const secrets = chans
      .map((c) => (c.credentials as { identity_secret?: string }).identity_secret)
      .filter((s): s is string => !!s);
    expect(secrets.length).toBeGreaterThan(0);
    const expected = (secret: string) =>
      createHmac('sha256', secret).update('shopify:777|shopper@store.com|Shop Patron').digest('hex');
    expect(secrets.some((s) => expected(s) === claim?.sig)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('app wiring', () => {
  it('the real app mounts the console link endpoints under /api/shopify', async () => {
    // The suite above mounts the route groups on a scratch Hono — this
    // boots the production app so a missing mount can't ship as a 404.
    const { createApp } = await import('../app.js');
    const res = await createApp(db).request('/api/shopify/link-info?code=forged.sig', {
      headers: { cookie },
    });
    expect(res.status).toBe(400); // mounted → code validation, not "route not found"
  });
});
