import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import {
  agentSecrets,
  agents,
  contacts,
  conversations,
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

const stubShopifyApi = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/admin/oauth/access_token')) {
        return Promise.resolve(
          Response.json({ access_token: 'shpat_offline', scope: 'read_orders,write_orders' }),
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

  it('installs the shop — token exchange + unlinked row + link url', async () => {
    stubShopifyApi();
    const res = await postSession(sessionJwt());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shop: string; state: string; link_url?: string };
    expect(body.shop).toBe(SHOP);
    expect(body.state).toBe('unlinked');
    expect(body.link_url).toContain('/shopify-link?code=');
    const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
    expect(row.accessTokenEnc).toBeTruthy();
    expect(row.scopes).toBe('read_orders,write_orders');
  });

  it('a second embedded load keeps the stored token — no re-exchange', async () => {
    stubShopifyApi();
    await postSession(sessionJwt());
    const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await postSession(sessionJwt());
    // only the graphql register calls could have fired — none did the
    // second time either since the token was already stored
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCalls);
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
});
