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
  agentMembers,
  agentSecrets,
  agents,
  alerts,
  channels,
  contacts,
  conversations,
  jobs,
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
let signAccessCode: (shopId: string, email: string) => string;

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
    // appSubscriptionCreate reply; 'fail' returns a userError.
    billing?: 'ok' | 'fail';
    // Theme settings probe — 'enabled'/'disabled' writes our block,
    // 'no-scope' 403s (read_themes not granted yet), unset = no match.
    embed?: 'enabled' | 'disabled' | 'absent' | 'no-scope';
    // Recovery-email send — 'ok' 200s, 'fail' 500s; captures the body.
    resend?: 'ok' | 'fail';
    onResend?: (body: Record<string, unknown>) => void;
  } = {},
) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.resend.com')) {
        if (opts.onResend && typeof init?.body === 'string')
          opts.onResend(JSON.parse(init.body) as Record<string, unknown>);
        if (opts.resend === 'fail')
          return Promise.resolve(new Response('{"message":"boom"}', { status: 500 }));
        return Promise.resolve(Response.json({ id: 're_1' }));
      }
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
      if (url.includes('themes.json')) {
        if (opts.embed === 'no-scope') return Promise.resolve(new Response('{}', { status: 403 }));
        return Promise.resolve(Response.json({ themes: [{ id: 7 }] }));
      }
      if (url.includes('assets.json')) {
        const blocks =
          opts.embed === 'enabled'
            ? { [`${KEY}-x`]: { type: 'shopify://apps/janis/blocks/janis-chat/abc', disabled: false } }
            : opts.embed === 'disabled'
              ? { [`${KEY}-x`]: { type: 'shopify://apps/janis/blocks/janis-chat/abc', disabled: true } }
              : {};
        return Promise.resolve(
          Response.json({ asset: { value: JSON.stringify({ current: { blocks } }) } }),
        );
      }
      if (url.includes('graphql.json')) {
        const q = typeof init?.body === 'string' ? init.body : '';
        if (q.includes('appSubscriptionCreate')) {
          return Promise.resolve(
            Response.json({
              data: {
                appSubscriptionCreate:
                  opts.billing === 'fail'
                    ? { userErrors: [{ message: 'shop cannot be charged' }] }
                    : {
                        confirmationUrl: 'https://shop.example/admin/charges/confirm',
                        appSubscription: { id: 'sub_1', status: 'PENDING' },
                        userErrors: [],
                      },
              },
            }),
          );
        }
        if (q.includes('partnerDevelopment')) {
          return Promise.resolve(
            Response.json({ data: { shop: { plan: { partnerDevelopment: true } } } }),
          );
        }
        return Promise.resolve(
          Response.json({
            data: {
              shop: { name: 'Test Shop', contactEmail: 'owner@test.dev', email: 'owner@test.dev' },
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
  signAccessCode = (await import('../lib/shopifyApp.js')).signAccessCode;

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

describe('janis embedded session token', () => {
  it('/session returns a janis_token accepted by the session-token endpoints', async () => {
    stubShopifyApi();
    // Distinct shop — this must not consume SHOP's first-load provision.
    const res = await postSession(sessionJwt('janis-tok.myshopify.com'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { janis_token?: string };
    expect(body.janis_token).toBeTruthy();
    // The Shopify JWT is only a bootstrap credential — after /session the
    // iframe runs entirely on the Janis-minted token, same auth surface.
    const inbox = await app.request('/api/shopify/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: body.janis_token }),
    });
    expect(inbox.status).toBe(200);
  });

  it('an expired janis session is rejected — and a forged iss alone does not pass', async () => {
    const dead = jwt({
      iss: 'janis-embedded',
      dest: `https://${SHOP}`,
      aud: KEY,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect((await postSession(dead)).status).toBe(401);
    const wrongSecret = jwt(
      {
        iss: 'janis-embedded',
        dest: `https://${SHOP}`,
        aud: KEY,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'wrong',
    );
    expect((await postSession(wrongSecret)).status).toBe(401);
  });
});

describe('shopify console access — magic sign-in', () => {
  const ACCESS_SHOP = 'access-store.myshopify.com';

  it('console-access accepts staff email; magic-login signs in, claims the workspace and sets the cookie', async () => {
    stubShopifyApi();
    await postSession(sessionJwt(ACCESS_SHOP)); // provision → linked
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, ACCESS_SHOP));
    expect(row.state).toBe('linked');
    // contactEmail persisted at provision (stub returns owner@test.dev).
    expect(row.contactEmail).toBe('owner@test.dev');

    // Synthetic staff row for this session's sub — console-access should
    // backfill its name with the requested address.
    await db.insert(users).values({
      email: `shopify-staff+42@${ACCESS_SHOP}`, name: 'Store staff',
    }).onConflictDoNothing();

    // No email → defaults to the persisted store contact email.
    const res0 = await app.request('/api/shopify/console-access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ACCESS_SHOP) }),
    });
    expect(res0.status).toBe(200);
    const body0 = await res0.json();
    expect(body0.sent_to).toBe('owner@test.dev');

    // Staff row now names the real address.
    const [su] = await db.select().from(users).where(
      eq(users.email, `shopify-staff+42@${ACCESS_SHOP}`));
    expect(su.name).toBe('owner@test.dev');

    // Explicit address still works.
    const res2 = await app.request('/api/shopify/console-access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ACCESS_SHOP), email: 'Owner@Store.com' }),
    });
    expect(res2.status).toBe(200);

    const code = signAccessCode(row.id, 'owner@store.com');
    const redeem = await app.request(
      `/api/shopify/magic-login?code=${encodeURIComponent(code)}`,
    );
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    expect(redeem.headers.get('location')).toBe('/');

    // New user claimed — admin membership, owns the provisioned workspace,
    // session lands in the store's workspace.
    const [u] = await db.select().from(users).where(eq(users.email, 'owner@store.com'));
    expect(u).toBeTruthy();
    const [m] = await db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.userId, u.id), eq(memberships.workspaceId, row.workspaceId!)),
      );
    expect(m?.role).toBe('admin');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId!));
    expect(ws.ownerUserId).toBe(u.id);
    const [sess] = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(sess.workspaceId).toBe(row.workspaceId);
  });

  it('a staff member on an OWNED workspace gets agent-scoped member, never workspace admin', async () => {
    const SHOP2 = 'staff-shop.myshopify.com';
    stubShopifyApi();
    await postSession(sessionJwt(SHOP2));
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP2));
    // Simulate a claimed workspace — the merchant bound to their existing
    // multi-agent workspace, which already has an owner.
    const [owner] = await db.insert(users).values({ email: 'real-owner@x.com', name: 'Owner' }).returning();
    await db.insert(memberships).values({
      userId: owner.id, workspaceId: row.workspaceId!, role: 'admin', acceptedAt: new Date(),
    });
    await db.update(workspaces).set({ ownerUserId: owner.id }).where(eq(workspaces.id, row.workspaceId!));

    const code = signAccessCode(row.id, 'staff@x.com');
    const redeem = await app.request(`/api/shopify/magic-login?code=${encodeURIComponent(code)}`);
    expect(redeem.status).toBe(302);

    const [u] = await db.select().from(users).where(eq(users.email, 'staff@x.com'));
    expect(u).toBeTruthy();
    // No workspace membership at all…
    const mem = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, u.id), eq(memberships.workspaceId, row.workspaceId!)));
    expect(mem).toHaveLength(0);
    // …just an agent-scoped member grant on the bound agent.
    const [grant] = await db
      .select()
      .from(agentMembers)
      .where(and(eq(agentMembers.userId, u.id), eq(agentMembers.agentId, row.agentId!)));
    expect(grant?.role).toBe('member');
    // And the existing owner was never disturbed.
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId!));
    expect(ws.ownerUserId).toBe(owner.id);
  });

  it('rejects a forged code and refuses a disconnected shop', async () => {
    expect(
      (await app.request('/api/shopify/magic-login?code=forged.code')).status,
    ).toBe(401);
    const [unlinked] = await db
      .insert(shopifyShops)
      .values({ shop: 'gone.myshopify.com', state: 'unlinked' })
      .returning();
    const res = await app.request(
      `/api/shopify/magic-login?code=${encodeURIComponent(signAccessCode(unlinked.id, 'x@y.com'))}`,
    );
    expect(res.status).toBe(409);
  });
});

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

describe('shopify in-frame agent setup', () => {
  const postAgent = (body: Record<string, unknown>) =>
    app.request('/api/shopify/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('edits the provisioned agent — name + greeting save through the session token', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('setup-shop.myshopify.com'));
    const res = await postAgent({
      token: sessionJwt('setup-shop.myshopify.com'),
      name: 'Shop Bot',
      greeting: 'Hey there!',
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'setup-shop.myshopify.com'));
    const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId!));
    expect(agent.name).toBe('Shop Bot');
    const cfg = agent.config as { greeting?: string; greeting_enabled?: boolean };
    expect(cfg.greeting).toBe('Hey there!');
    expect(cfg.greeting_enabled).toBe(true);
  });

  it('saves a changed purpose even when the draft generator is unavailable', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('purpose-shop.myshopify.com'));
    const res = await postAgent({
      token: sessionJwt('purpose-shop.myshopify.com'),
      purpose: 'Only answer shipping questions.',
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'purpose-shop.myshopify.com'));
    const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId!));
    expect((agent.config as { purpose?: string }).purpose).toBe('Only answer shipping questions.');
  });

  it('rejects a foreign session token and an unlinked shop', async () => {
    expect(
      (await postAgent({ token: sessionJwt(SHOP, {}, 'wrong'), name: 'x' })).status,
    ).toBe(401);
    const [bare] = await db
      .insert(shopifyShops)
      .values({ shop: 'no-agent.myshopify.com', provisionedAt: new Date() })
      .returning();
    expect(bare.agentId).toBeNull();
    expect(
      (await postAgent({ token: sessionJwt('no-agent.myshopify.com'), name: 'x' })).status,
    ).toBe(409);
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

describe('shopify embedded billing + theme detection', () => {
  it('/plan returns a Shopify confirmation URL for a linked shop', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('billing-shop.myshopify.com'));
    const res = await app.request('/api/shopify/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt('billing-shop.myshopify.com'), plan: 'starter' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmation_url: string; test_mode: boolean };
    expect(body.confirmation_url).toContain('/admin/charges/confirm');
    expect(body.test_mode).toBe(true); // dev store → test charge
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'billing-shop.myshopify.com'));
    expect((row.billing as { subscriptionId?: string }).subscriptionId).toBe('sub_1');
  });

  it('/plan refuses an unlinked shop and a forged token', async () => {
    const [bare] = await db
      .insert(shopifyShops)
      .values({ shop: 'nobill.myshopify.com', provisionedAt: new Date() })
      .returning();
    expect(bare.state).toBe('unlinked');
    const res = await app.request('/api/shopify/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt('nobill.myshopify.com'), plan: 'pro' }),
    });
    expect(res.status).toBe(409);
    const forged = await app.request('/api/shopify/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(SHOP, {}, 'wrong'), plan: 'pro' }),
    });
    expect(forged.status).toBe(401);
  });

  it('session reports plan/usage/billing/embed state on a linked shop', async () => {
    stubShopifyApi({ embed: 'enabled' });
    const res = await postSession(sessionJwt('metered.myshopify.com'));
    const body = (await res.json()) as {
      state: string;
      plan?: string;
      usage?: { used: number; included: number; capped: boolean };
      embed_enabled?: boolean | null;
      plans?: { key: string }[];
    };
    expect(body.state).toBe('linked');
    expect(body.plan).toBe('free');
    expect(body.usage?.included).toBe(250);
    expect(body.embed_enabled).toBe(true);
    expect(body.plans?.map((p) => p.key)).toEqual(['starter', 'pro', 'scale']);
  });

  it('embed_enabled is null when read_themes is not granted', async () => {
    stubShopifyApi({ embed: 'no-scope' });
    const res = await postSession(sessionJwt('noscope.myshopify.com'));
    expect(((await res.json()) as { embed_enabled?: boolean | null }).embed_enabled).toBeNull();
  });

  it('rebinding a provisioned shop tears down the orphaned workspace', async () => {
    stubShopifyApi();
    await postSession(sessionJwt('orphan.myshopify.com'));
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'orphan.myshopify.com'));
    const provisionedWs = row.workspaceId!;
    // Merchant consolidates: binds the shop to an agent in their own
    // workspace — the provisioned shell should disappear with it.
    const link = await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code: signLinkCode(row.id), agent_id: agentId }),
    });
    expect(link.status).toBe(200);
    const [gone] = await db.select().from(workspaces).where(eq(workspaces.id, provisionedWs));
    expect(gone).toBeUndefined();
    // Rebind clears the test workspace for later tests.
    await db
      .update(shopifyShops)
      .set({ workspaceId: null, agentId: null, state: 'unlinked', provisionedAt: new Date() })
      .where(eq(shopifyShops.id, row.id));
  });
});

describe('shopify in-frame inbox', () => {
  const INBOX_SHOP = 'inbox-shop.myshopify.com';

  const provisionInboxShop = async () => {
    stubShopifyApi();
    await postSession(sessionJwt(INBOX_SHOP, { sub: '77' }));
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, INBOX_SHOP));
    return row;
  };

  it('lists only the bound agent\'s conversations', async () => {
    const row = await provisionInboxShop();
    // A conversation on the shop's own provisioned agent…
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: row.agentId!, externalId: 'webchat:visitor-list', isUnread: true })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'is this in stock?' });
    // …and one on the test workspace's agent — must not leak into the shop's inbox.
    await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:other-store' });

    const res = await app.request('/api/shopify/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(INBOX_SHOP, { sub: '77' }) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: { id: string; is_unread: boolean }[] };
    expect(body.conversations.map((cv) => cv.id)).toEqual([conv.id]);
    expect(body.conversations[0].is_unread).toBe(true);

    // Other shops + forged tokens get nothing.
    const forged = await app.request('/api/shopify/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(INBOX_SHOP, {}, 'wrong') }),
    });
    expect(forged.status).toBe(401);
  });

  it('thread returns messages, marks the conversation read, and 404s foreign agents', async () => {
    const row = await provisionInboxShop();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: row.agentId!, externalId: 'webchat:visitor-thread', isUnread: true })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: 'in', text: 'hello?' });
    const [foreign] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:not-yours' })
      .returning();

    const res = await app.request('/api/shopify/inbox/thread', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(INBOX_SHOP, { sub: '77' }),
        conversation_id: conv.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { is_unread: boolean };
      messages: { direction: string; text: string }[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('hello?');
    expect(body.conversation.is_unread).toBe(false);

    const foreignRes = await app.request('/api/shopify/inbox/thread', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(INBOX_SHOP, { sub: '77' }),
        conversation_id: foreign.id,
      }),
    });
    expect(foreignRes.status).toBe(404);
  });

  it('reply auto-takes-over, attributes to store staff, and resume hands back', async () => {
    const row = await provisionInboxShop();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: row.agentId!, externalId: 'webchat:visitor-reply' })
      .returning();

    const reply = await app.request('/api/shopify/inbox/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(INBOX_SHOP, { sub: '77' }),
        conversation_id: conv.id,
        text: 'Yes, we have it in stock!',
      }),
    });
    expect(reply.status).toBe(201);
    const rbody = (await reply.json()) as {
      message: { direction: string; text: string };
      state: string;
    };
    expect(rbody.message.direction).toBe('human');
    expect(rbody.state).toBe('human');

    // Conversation flipped to human mode; the staff identity row exists
    // (Admin API user lookup didn't resolve under the stub → generic label).
    const [after] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(after.state).toBe('human');
    const [staff] = await db
      .select()
      .from(users)
      .where(eq(users.email, `shopify-staff+77@${INBOX_SHOP}`));
    expect(staff.name).toBe('Store staff');
    expect(after.assigneeId).toBe(staff.id);
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const human = stored.find((m) => m.direction === 'human' && m.text.includes('in stock'));
    expect(human?.authorId).toBe(staff.id);

    // Resume hands the thread back to the agent.
    const res = await app.request('/api/shopify/inbox/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(INBOX_SHOP, { sub: '77' }),
        conversation_id: conv.id,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('active');
  });

  it('rejects replies on archived and foreign conversations', async () => {
    const row = await provisionInboxShop();
    const [archConv] = await db
      .insert(conversations)
      .values({ agentId: row.agentId!, externalId: 'webchat:old', state: 'archived' })
      .returning();
    const res = await app.request('/api/shopify/inbox/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(INBOX_SHOP, { sub: '77' }),
        conversation_id: archConv.id,
        text: 'hi',
      }),
    });
    expect(res.status).toBe(409);
    const unlinked = await app.request('/api/shopify/inbox/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt('no-inbox.myshopify.com'),
        conversation_id: archConv.id,
        text: 'hi',
      }),
    });
    // 'no-inbox' shop doesn't exist at all → treated as unlinked.
    expect([409, 401]).toContain(unlinked.status);
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
      `/api/shopify/storefront.js?s=${SHOP}&accent=%23aabbcc&position=left&launcher=${encodeURIComponent('https://cdn.shopify.com/icon.png')}&logo=${encodeURIComponent('https://cdn.shopify.com/logo.png')}&teaser=Hi!&greeting=Hello&qrs=${encodeURIComponent('Track order, Returns')}&bogus=ignored&accent2=notahex&launcher2=javascript:x`,
    );
    const js = await res.text();
    expect(js).toContain('data-janis-accent');
    expect(js).toContain('#aabbcc');
    expect(js).toContain('data-janis-position');
    expect(js).toContain('"left"');
    expect(js).toContain('data-janis-launcher');
    expect(js).toContain('cdn.shopify.com/icon.png');
    expect(js).toContain('data-janis-logo');
    expect(js).toContain('cdn.shopify.com/logo.png');
    expect(js).toContain('data-janis-teaser');
    expect(js).toContain('data-janis-greeting');
    expect(js).toContain('data-janis-replies');
    expect(js).toContain('Track order');
    // unwhitelisted/invalid params never reach the tag
    expect(js).not.toContain('bogus');
    expect(js).not.toContain('notahex');
    expect(js).not.toContain('javascript:');
  });

  it('launcher icon keywords pass through; junk values drop', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    for (const kw of ['glyph', 'logo']) {
      const res = await app.request(
        `/api/shopify/storefront.js?s=${SHOP}&launcher=${kw}`,
      );
      const js = await res.text();
      expect(js).toContain(`data-janis-launcher',"${kw}"`);
    }
    // A bare non-https value is not a valid launcher — no attr emitted.
    const bad = await app.request(
      `/api/shopify/storefront.js?s=${SHOP}&launcher=${encodeURIComponent('javascript:alert(1)')}`,
    );
    expect(await bad.text()).not.toContain('data-janis-launcher');
    // Same rule for the chat-window logo — https only.
    const badLogo = await app.request(
      `/api/shopify/storefront.js?s=${SHOP}&logo=${encodeURIComponent('javascript:alert(1)')}`,
    );
    expect(await badLogo.text()).not.toContain('data-janis-logo');
    // Protocol-relative URLs — what Shopify's image_url actually emits for
    // image_picker settings — normalize to https instead of dropping.
    const rel = await app.request(
      `/api/shopify/storefront.js?s=${SHOP}&launcher=${encodeURIComponent('//cdn.shopify.com/icon.png')}&logo=${encodeURIComponent('//cdn.shopify.com/logo.png')}`,
    );
    const relJs = await rel.text();
    expect(relJs).toContain('data-janis-launcher');
    expect(relJs).toContain('https://cdn.shopify.com/icon.png');
    expect(relJs).toContain('data-janis-logo');
    expect(relJs).toContain('https://cdn.shopify.com/logo.png');
  });

  it('theme-embed settings persist onto flat channel credentials', async () => {
    stubShopifyApi();
    const code = await linkCodeFor();
    await app.request('/api/shopify/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code, agent_id: agentId }),
    });
    await app.request(
      `/api/shopify/storefront.js?s=${SHOP}&accent=%23aabbcc&launcher=logo&logo=${encodeURIComponent('https://cdn.shopify.com/logo.png')}&teaser=${encodeURIComponent('Need help?')}&qrs=${encodeURIComponent('Track order, Returns')}`,
    );
    // The sync write is fire-and-forget — give it a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    const [chan] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.agentId, agentId), eq(channels.kind, 'webchat')));
    const creds = chan.credentials as Record<string, unknown>;
    // Flat keys are what the widget bootstrap + console editor read.
    expect(creds.accent).toBe('#aabbcc');
    expect(creds.launcher).toBe('logo');
    expect(creds.logo_url).toBe('https://cdn.shopify.com/logo.png');
    expect(creds.teaser_text).toBe('Need help?');
    expect(creds.quick_replies).toEqual(['Track order', 'Returns']);
    expect(creds.branding).toBeUndefined();
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

describe('abandoned-checkout nudge, ask + stats', () => {
  const ASHOP = 'ask-shop.myshopify.com';
  const provision = async () => {
    stubShopifyApi();
    await postSession(sessionJwt(ASHOP, { sub: '77' }));
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, ASHOP));
    return row;
  };
  const plantShopper = async (row: { workspaceId: string | null; agentId: string | null }, email: string) => {
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: row.workspaceId!, email })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: row.agentId!, externalId: `chat:${email}`, contactId: contact.id })
      .returning();
    return conv;
  };
  const nudgeMsgs = async (convId: string) =>
    (await db.select().from(messages).where(eq(messages.conversationId, convId))).filter(
      (m) => (m.payload as { event?: string })?.event === 'checkout_nudge',
    );

  it('checkouts/update enqueues exactly one nudge job per checkout token', async () => {
    const row = await provision();
    const conv = await plantShopper(row, 'nudge1@x.com');
    const payload = {
      token: 'chk-n1',
      email: 'nudge1@x.com',
      total_price: '50.00',
      currency: 'USD',
      line_items: [{ title: 'Wax' }],
    };
    await webhook('checkouts/update', payload, SECRET, ASHOP);
    await webhook('checkouts/update', { ...payload, total_price: '51.00' }, SECRET, ASHOP);
    // Other shops/tests enqueue their own nudges — scope to this conv.
    const jobRows = (await db.select().from(jobs).where(eq(jobs.type, 'shopify.checkout_nudge'))).filter(
      (j) => (j.payload as { convId?: string }).convId === conv.id,
    );
    expect(jobRows.length).toBe(1);
    const p = jobRows[0].payload as { convId?: string; checkoutToken?: string };
    expect(p.convId).toBe(conv.id);
    expect(p.checkoutToken).toBe('chk-n1');
  });

  it('nudge writes an internal directive, dedupes, and skips converted checkouts', async () => {
    const row = await provision();
    const conv = await plantShopper(row, 'nudge2@x.com');
    const { runCheckoutNudge } = await import('../lib/shopifyApp.js');

    await runCheckoutNudge(db, row.workspaceId!, {
      convId: conv.id,
      checkoutToken: 'chk-a',
      summary: 'Shopify: checkout activity — 1 item, USD 50.00',
    });
    expect((await nudgeMsgs(conv.id)).length).toBe(1);
    const [dir] = await nudgeMsgs(conv.id);
    // The instruction is an inbound internal row — the visitor transcript
    // filters it, but the model reads it as the turn to answer.
    expect(dir.direction).toBe('in');
    expect((dir.payload as { internal?: boolean }).internal).toBe(true);
    // The reply pass fires immediately after — lastMessageDirection settles
    // on whatever the run did; what matters is the directive reached the
    // model as the latest inbound turn.
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(['in', 'out']).toContain(after.lastMessageDirection);

    // A retried job for the same checkout must not nag twice.
    await runCheckoutNudge(db, row.workspaceId!, { convId: conv.id, checkoutToken: 'chk-a' });
    expect((await nudgeMsgs(conv.id)).length).toBe(1);

    // Conversion silences the nudge: orders/create carries checkout_token.
    const conv2 = await plantShopper(row, 'nudge3@x.com');
    await webhook(
      'orders/create',
      { id: 991, name: '#2001', email: 'nudge3@x.com', total_price: '12.00', currency: 'USD', checkout_token: 'chk-b' },
      SECRET,
      ASHOP,
    );
    const orderNote = (await db.select().from(messages).where(eq(messages.conversationId, conv2.id))).find(
      (m) => (m.payload as { event?: string })?.event === 'order_event',
    );
    expect((orderNote?.payload as { order?: { checkout_token?: string } })?.order?.checkout_token).toBe('chk-b');
    await runCheckoutNudge(db, row.workspaceId!, { convId: conv2.id, checkoutToken: 'chk-b' });
    expect((await nudgeMsgs(conv2.id)).length).toBe(0);
  });

  it('settings off → checkouts/update does not enqueue the nudge', async () => {
    const row = await provision();
    await plantShopper(row, 'nudge4@x.com');
    const res = await app.request('/api/shopify/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), nudge: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: { nudge: boolean } }).settings.nudge).toBe(false);
    await webhook(
      'checkouts/update',
      { token: 'chk-off', email: 'nudge4@x.com', total_price: '1.00', currency: 'USD', line_items: [{ title: 'x' }] },
      SECRET,
      ASHOP,
    );
    const jobRows = (await db.select().from(jobs).where(eq(jobs.type, 'shopify.checkout_nudge'))).filter(
      (j) => (j.payload as { checkoutToken?: string }).checkoutToken === 'chk-off',
    );
    expect(jobRows.length).toBe(0);
  });

  it('checkouts/update enqueues the 3-touch email sequence — touch 1 only without marketing consent', async () => {
    const row = await provision();
    const conv = await plantShopper(row, 'rec1@x.com');
    await webhook(
      'checkouts/update',
      {
        token: 'chk-e1',
        email: 'rec1@x.com',
        total_price: '50.00',
        currency: 'USD',
        line_items: [{ title: 'Wax', quantity: 1 }],
        abandoned_checkout_url: 'https://checkout.example/c/chk-e1',
        buyer_accepts_marketing: true,
      },
      SECRET,
      ASHOP,
    );
    const conv2 = await plantShopper(row, 'rec2@x.com');
    await webhook(
      'checkouts/update',
      {
        token: 'chk-e2',
        email: 'rec2@x.com',
        total_price: '9.00',
        currency: 'USD',
        line_items: [{ title: 'x' }],
        abandoned_checkout_url: 'https://checkout.example/c/chk-e2',
        buyer_accepts_marketing: false,
      },
      SECRET,
      ASHOP,
    );
    const emailJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.type, 'shopify.checkout_email'));
    const forConv = (id: string) =>
      emailJobs.filter((j) => (j.payload as { convId?: string }).convId === id);
    // Consented shopper: all three touches; non-consented: reminder only.
    expect(
      forConv(conv.id)
        .map((j) => (j.payload as { step?: number }).step)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(forConv(conv2.id).map((j) => (j.payload as { step?: number }).step)).toEqual([1]);
    // Touch 1 lands ~1h out; 2 at ~24h; 3 at ~72h.
    const t1 = forConv(conv.id).find((j) => (j.payload as { step?: number }).step === 1)!;
    const t3 = forConv(conv.id).find((j) => (j.payload as { step?: number }).step === 3)!;
    expect(Math.abs(t1.runAt.getTime() - Date.now() - 3600_000)).toBeLessThan(60_000);
    expect(Math.abs(t3.runAt.getTime() - Date.now() - 72 * 3600_000)).toBeLessThan(60_000);
    // The recovery context rides the job payload.
    const p = t1.payload as { checkoutUrl?: string; email?: string };
    expect(p.checkoutUrl).toBe('https://checkout.example/c/chk-e1');
    expect(p.email).toBe('rec1@x.com');

    // Toggle off → no email jobs for the next checkout.
    await app.request('/api/shopify/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), recovery_email: false }),
    });
    await webhook(
      'checkouts/update',
      {
        token: 'chk-e3',
        email: 'rec1@x.com',
        total_price: '5.00',
        currency: 'USD',
        line_items: [{ title: 'y' }],
        abandoned_checkout_url: 'https://checkout.example/c/chk-e3',
      },
      SECRET,
      ASHOP,
    );
    const after = (await db.select().from(jobs).where(eq(jobs.type, 'shopify.checkout_email')))
      .filter((j) => (j.payload as { checkoutToken?: string }).checkoutToken === 'chk-e3');
    expect(after.length).toBe(0);
    // Restore for the rest of the suite.
    await app.request('/api/shopify/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), recovery_email: true }),
    });
  });

  it('recovery email sends once per touch, honors consent/conversion/opt-out', async () => {
    const row = await provision();
    const { env } = await import('../env.js');
    const prev = env.resendApiKey;
    env.resendApiKey = 'rk_test';
    const sentBodies: Record<string, unknown>[] = [];
    stubShopifyApi({ resend: 'ok', onResend: (b) => sentBodies.push(b) });
    try {
      const { runCheckoutEmail } = await import('../lib/shopifyApp.js');
      const conv = await plantShopper(row, 'rec3@x.com');
      const job = {
        shopId: row.id,
        convId: conv.id,
        checkoutToken: 'chk-r3',
        email: 'rec3@x.com',
        checkoutUrl: 'https://checkout.example/c/chk-r3',
        step: 1,
        marketing: true,
        items: '1× Wax',
      };
      await runCheckoutEmail(db, row.workspaceId!, job);
      expect(sentBodies.length).toBe(1);
      expect((sentBodies[0].to as string[])[0]).toBe('rec3@x.com');
      expect(String(sentBodies[0].from)).toContain('Test Shop via Janis');
      const marks = async (convId: string) =>
        (await db.select().from(messages).where(eq(messages.conversationId, convId))).filter(
          (m) => (m.payload as { event?: string })?.event === 'checkout_email',
        );
      const [mark] = await marks(conv.id);
      expect((mark.payload as { sent?: boolean }).sent).toBe(true);
      expect(mark.text).toContain('Recovery email 1/3 sent');

      // A retried job must not re-send or re-mark.
      await runCheckoutEmail(db, row.workspaceId!, job);
      expect(sentBodies.length).toBe(1);
      expect((await marks(conv.id)).length).toBe(1);

      // Marketing consent gates touches 2+.
      await runCheckoutEmail(db, row.workspaceId!, { ...job, step: 2, marketing: false });
      expect(sentBodies.length).toBe(1);

      // Conversion silences later touches — orders/create carries the token.
      await webhook(
        'orders/create',
        { id: 992, name: '#2002', email: 'rec3@x.com', total_price: '12.00', currency: 'USD', checkout_token: 'chk-r3' },
        SECRET,
        ASHOP,
      );
      await runCheckoutEmail(db, row.workspaceId!, { ...job, step: 2, marketing: true });
      expect(sentBodies.length).toBe(1);

      // Opted-out contact blocks the send entirely.
      const conv2 = await plantShopper(row, 'rec4@x.com');
      await db
        .update(contacts)
        .set({ metadata: { recovery_unsubscribed: true } })
        .where(eq(contacts.id, conv2.contactId!));
      await runCheckoutEmail(db, row.workspaceId!, {
        ...job,
        convId: conv2.id,
        checkoutToken: 'chk-r4',
        email: 'rec4@x.com',
      });
      expect(sentBodies.length).toBe(1);
      expect((await marks(conv2.id)).length).toBe(0);
    } finally {
      env.resendApiKey = prev;
    }
  });

  it('recovery-unsubscribe marks the contact and rejects bad signatures', async () => {
    const row = await provision();
    const conv = await plantShopper(row, 'unsub@x.com');
    const { env } = await import('../env.js');
    const sig = createHmac('sha256', env.sessionSecret)
      .update(`recovery-unsub:${conv.id}`)
      .digest('base64url');
    const bad = await app.request(`/shopify/recovery-unsubscribe?c=${conv.id}&t=bogus`);
    expect(bad.status).toBe(400);
    const ok = await app.request(`/shopify/recovery-unsubscribe?c=${conv.id}&t=${sig}`);
    expect(ok.status).toBe(200);
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, conv.contactId!));
    expect(
      (contact.metadata as { recovery_unsubscribed?: boolean }).recovery_unsubscribed,
    ).toBe(true);
  });

  it('quietHoursDefer clamps sends to 7am–9pm shop-local', async () => {
    const { quietHoursDefer } = await import('../lib/shopifyApp.js');
    // Noon UTC → in-window, no deferral.
    expect(quietHoursDefer(new Date('2026-10-15T12:00:00Z'), 'UTC')).toBe(0);
    // 3:30am → defers 3.5h to 7am.
    expect(quietHoursDefer(new Date('2026-10-15T03:30:00Z'), 'UTC')).toBe(210 * 60_000);
    // 10:15pm → defers 8h45m to next-morning 7am.
    expect(quietHoursDefer(new Date('2026-10-15T22:15:00Z'), 'UTC')).toBe(525 * 60_000);
    // Unknown tz → unclamped.
    expect(quietHoursDefer(new Date('2026-10-15T03:30:00Z'), undefined)).toBe(0);
  });

  it('session stats count email-recovered orders separately', async () => {
    const row = await provision();
    const conv = await plantShopper(row, 'rec5@x.com');
    // A sent recovery marker for chk-r5, then the order lands on it.
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'out',
      text: 'Recovery email 1/3 sent',
      payload: { internal: true, event: 'checkout_email', checkout: 'chk-r5', step: 1, sent: true },
    });
    await webhook(
      'orders/create',
      { id: 993, name: '#2003', email: 'rec5@x.com', total_price: '40.00', currency: 'USD', checkout_token: 'chk-r5' },
      SECRET,
      ASHOP,
    );
    const { shopifyStats } = await import('../lib/shopifyApp.js');
    const stats = await shopifyStats(db, row, {});
    // The same shop row persists across tests — chk-r3's order above also
    // qualifies (marker before order), so assert the USD bucket includes
    // this test's $40 order rather than a literal total.
    const usd = stats.recovered_30d.find((r) => r.currency === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.amount).toBeGreaterThanOrEqual(40);
    expect(usd!.orders).toBeGreaterThanOrEqual(1);
  });

  it('ask threads are verified merchant convs, hidden from the shopper inbox', async () => {
    const row = await provision();
    // the nudge-off setting above persists — flip back for isolation sanity
    const res = await app.request('/api/shopify/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), text: 'how did we do today?' }),
    });
    expect(res.status).toBe(200);
    const { conversation_id } = (await res.json()) as { conversation_id: string };
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversation_id));
    const profile = conv.userProfile as { kind?: string; identity_verified?: boolean; external_id?: string };
    expect(profile.kind).toBe('merchant_ask');
    expect(profile.identity_verified).toBe(true);
    expect(profile.external_id).toBeTruthy();
    const inb = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(inb.some((m) => m.direction === 'in' && m.text === 'how did we do today?')).toBe(true);

    // Hidden from the embedded inbox…
    const inbox = await app.request('/api/shopify/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }) }),
    });
    const list = ((await inbox.json()) as { conversations: { id: string }[] }).conversations;
    expect(list.map((c) => c.id)).not.toContain(conv.id);

    // …but the thread endpoint still serves it for the Ask tab.
    const thread = await app.request('/api/shopify/inbox/thread', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), conversation_id: conv.id }),
    });
    expect(thread.status).toBe(200);

    // A second staff member gets their own thread.
    const res2 = await app.request('/api/shopify/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '88' }), text: 'show me top products' }),
    });
    const { conversation_id: other } = (await res2.json()) as { conversation_id: string };
    expect(other).not.toBe(conv.id);

    // /session hands back this staff member's ask thread so the tab resumes.
    const sess = await postSession(sessionJwt(ASHOP, { sub: '77' }));
    expect(((await sess.json()) as { ask_conversation_id?: string }).ask_conversation_id).toBe(conv.id);
  });

  it('session stats count chat-attributed orders and revenue', async () => {
    const row = await provision();
    await plantShopper(row, 'stat@x.com');
    await webhook(
      'orders/create',
      { id: 881, name: '#9', email: 'stat@x.com', total_price: '42.50', currency: 'USD' },
      SECRET,
      ASHOP,
    );
    const sess = await postSession(sessionJwt(ASHOP, { sub: '77' }));
    const body = (await sess.json()) as {
      stats: { orders_30d: number; revenue_30d: { amount: number; currency: string }[] };
    };
    expect(body.stats.orders_30d).toBeGreaterThanOrEqual(1);
    const usd = body.stats.revenue_30d.find((r) => r.currency === 'USD');
    expect(usd?.amount).toBeGreaterThanOrEqual(42.5);
  });

  it('ask accepts attachments and staff count as operators', async () => {
    await provision();
    const res = await app.request('/api/shopify/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(ASHOP, { sub: '77' }),
        text: 'what is in this screenshot?',
        attachments: [{ name: 'shot.png', url: '/uploads/x.png', type: 'image/png', size: 12 }],
      }),
    });
    expect(res.status).toBe(200);
    const { conversation_id } = (await res.json()) as { conversation_id: string };
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    const inb = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const inbound = inb.find(
      (m) => m.direction === 'in' && m.text === 'what is in this screenshot?',
    );
    const atts = (inbound?.payload as { attachments?: { name: string }[] })?.attachments;
    expect(atts?.[0]?.name).toBe('shot.png');

    // Merchant-ask identity resolves as an operator — customer-record tools
    // run unbound for staff, and concierge gating treats the card visitor as
    // the decider.
    const { verifiedIdentityFor } = await import('../lib/hostedAgent.js');
    const id = await verifiedIdentityFor(db, conv, workspaceId);
    expect(id.operator).toBe(true);
    const { isConciergeAction } = await import('../lib/approvals.js');
    expect(isConciergeAction(workspaceId, conv.userProfile)).toBe(true);
  });

  it('copilot builtins are the concierge set — stats, gaps, teaching', async () => {
    const { env } = await import('../env.js');
    const prev = env.operatorWorkspaceId;
    env.operatorWorkspaceId = workspaceId;
    try {
      const { copilotBuiltins } = await import('../lib/builtinTools.js');
      const names = copilotBuiltins().map((b) => b.name);
      expect(names).toContain('workspace_stats');
      expect(names).toContain('knowledge_gaps');
      expect(names).toContain('teach_agent');
      expect(names).toContain('debug_conversation');
    } finally {
      env.operatorWorkspaceId = prev;
    }
  });

  it('ask/decide resolves a parked card on the staff member\u2019s own thread only', async () => {
    const row = await provision();
    const res = await app.request('/api/shopify/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '77' }), text: 'hi' }),
    });
    const { conversation_id } = (await res.json()) as { conversation_id: string };
    const staff = await db.select().from(users).where(eq(users.email, `shopify-staff+77@${ASHOP}`));
    const { pendingActions } = await import('../db/schema.js');
    const [action] = await db
      .insert(pendingActions)
      .values({
        workspaceId: row.workspaceId!,
        agentId: row.agentId!,
        conversationId: conversation_id,
        toolName: 'teach_agent',
        tool: { builtin: 'teach_agent' } as never,
        args: { facts: ['test fact'] } as never,
      })
      .returning();
    expect(staff.length).toBe(1);

    // A different staff member can't decide it.
    const denied404 = await app.request('/api/shopify/ask/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(ASHOP, { sub: '88' }),
        action_id: action.id,
        decision: 'denied',
      }),
    });
    expect(denied404.status).toBe(404);

    // The owner of the thread decides — denied leaves the action resolved.
    const deny = await app.request('/api/shopify/ask/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(ASHOP, { sub: '77' }),
        action_id: action.id,
        decision: 'denied',
      }),
    });
    expect(deny.status).toBe(200);
    expect(((await deny.json()) as { status: string }).status).toBe('denied');

    // Second decide is a conflict.
    const again = await app.request('/api/shopify/ask/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: sessionJwt(ASHOP, { sub: '77' }),
        action_id: action.id,
        decision: 'approved',
      }),
    });
    expect(again.status).toBe(409);
  });

  it('pinned workspace: staff run copilot tools with no Janis membership', async () => {
    const { env } = await import('../env.js');
    const prev = env.operatorWorkspaceId;
    env.operatorWorkspaceId = workspaceId;
    try {
      const row = await provision();
      const res = await app.request('/api/shopify/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: sessionJwt(ASHOP, { sub: '91' }), text: 'stats?' }),
      });
      const { conversation_id } = (await res.json()) as { conversation_id: string };
      const { copilotBuiltins } = await import('../lib/builtinTools.js');
      const ctx = {
        db,
        convId: conversation_id,
        workspaceId: row.workspaceId!,
        agent: { id: row.agentId!, workspaceId: row.workspaceId! },
        pinWorkspaceId: row.workspaceId!,
      };

      // Read tool — the pin resolves the workspace without any membership.
      const stats = copilotBuiltins().find((b) => b.name === 'workspace_stats')!;
      const out = await stats.run({}, ctx);
      expect(out).not.toMatch(/"error"|^error/);

      // adminOnly write on an ownerless workspace — staff act as operator,
      // and the write still parks as an approval card rather than executing.
      const teach = copilotBuiltins().find((b) => b.name === 'teach_agent')!;
      const t = await teach.run({ entry: 'test fact from the ask tab' }, ctx);
      expect(t).toContain('action_card');
      const { pendingActions } = await import('../db/schema.js');
      const acts = await db
        .select()
        .from(pendingActions)
        .where(eq(pendingActions.conversationId, conversation_id));
      expect(acts.length).toBe(1);
      expect(acts[0].toolName).toBe('apply_knowledge');
    } finally {
      env.operatorWorkspaceId = prev;
    }
  });
});
