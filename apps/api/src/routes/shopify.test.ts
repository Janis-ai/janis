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
  channels,
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
          Response.json({
            access_token: 'shpat_offline',
            scope: 'read_orders,write_orders,read_products,read_customers',
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
    expect(row.scopes).toBe('read_orders,write_orders,read_products,read_customers');
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

  it('an unbound reinstall lands back on unlinked, not stuck on uninstalled', async () => {
    stubShopifyApi();
    // Fresh row with a token, then uninstall (unbound — no agent linked)
    await postSession(sessionJwt('fresh.myshopify.com'));
    await webhook('app/uninstalled', {}, SECRET, 'fresh.myshopify.com');
    let [row] = await db
      .select()
      .from(shopifyShops)
      .where(eq(shopifyShops.shop, 'fresh.myshopify.com'));
    expect(row.state).toBe('uninstalled');
    // Reinstall → session exchange must restore the link flow
    const res = await postSession(sessionJwt('fresh.myshopify.com'));
    const body = (await res.json()) as { state: string; link_url?: string };
    expect(body.state).toBe('unlinked');
    expect(body.link_url).toContain('/shopify-link?code=');
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
