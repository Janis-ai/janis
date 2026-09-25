import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agentConnections, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { agentRoutes } from './agents.js';

let app: Hono;
let db: Db;
let childCookie: string;
let parentCookie: string;

const postAgent = (cookie: string) =>
  app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'New Bot' }),
  });

const cookieFor = async (workspaceId: string, email: string) => {
  const [u] = await db
    .insert(users)
    .values({ email, name: email })
    .returning();
  await db.insert(memberships).values({
    userId: u.id,
    workspaceId,
    role: 'admin',
    acceptedAt: new Date(),
  });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  return `${SESSION_COOKIE}=${token}`;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/agents', agentRoutes(db));

  const [parent] = await db
    .insert(workspaces)
    .values({ name: 'Agency Parent', plan: 'internal' })
    .returning();
  const [child] = await db
    .insert(workspaces)
    .values({
      name: 'Child Account',
      parentWorkspaceId: parent.id,
      parentContact: 'boss@agency.test',
    })
    .returning();
  const [subbed] = await db
    .insert(workspaces)
    .values({
      name: 'Child Upgraded',
      parentWorkspaceId: parent.id,
      stripeSubscriptionId: 'sub_own',
    })
    .returning();
  parentCookie = await cookieFor(parent.id, 'p@x.test');
  childCookie = await cookieFor(child.id, 'c@x.test');
  // upgraded child reuses its own cookie via a second session below
  (globalThis as Record<string, unknown>).__subbedId = subbed.id;
});

describe('agency child agent gating', () => {
  it('blocks an unsubscribed child with a who-to-contact message', async () => {
    const res = await postAgent(childCookie);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.covered_by).toBe('Agency Parent');
    expect(body.error).toContain('boss@agency.test');
  });

  it('lets the parent create agents freely', async () => {
    expect((await postAgent(parentCookie)).status).toBe(201);
  });

  it('lets a child with its own subscription create agents', async () => {
    const subbedId = (globalThis as Record<string, unknown>).__subbedId as string;
    const cookie = await cookieFor(subbedId, 's@x.test');
    expect((await postAgent(cookie)).status).toBe(201);
  });
});

describe('tool template install', () => {
  afterEach(() => vi.unstubAllGlobals());
  const newAgentId = async () => {
    const res = await postAgent(parentCookie);
    const body = await res.json();
    return body.agent.id as string;
  };

  it('installs a no-field template (itunes) with zero secrets', async () => {
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'itunes', fields: {} }),
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    expect(agent.config.tools.map((t: { name: string }) => t.name)).toContain('itunes_search');
  });

  it('stores credentials as secrets and merges tools without duplicating', async () => {
    const id = await newAgentId();
    const install = () =>
      app.request(`/api/agents/${id}/tools/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: parentCookie },
        body: JSON.stringify({
          template: 'shopify',
          fields: { shop: 'mystore', token: 'shpat_test' },
        }),
      });
    await install();
    await install(); // reinstall — merges by name, not duplicates
    const secrets = await (
      await app.request(`/api/agents/${id}/secrets`, { headers: { cookie: parentCookie } })
    ).json();
    const names = secrets.secrets.map((s: { name: string }) => s.name);
    expect(names).toContain('SHOPIFY_TOKEN');
    expect(names).toContain('SHOPIFY_SHOP');
    const list = await (
      await app.request('/api/agents', { headers: { cookie: parentCookie } })
    ).json();
    const agent = list.agents.find((a: { id: string }) => a.id === id);
    const toolNames = agent.config.tools.map((t: { name: string }) => t.name);
    expect(toolNames.filter((n: string) => n === 'shopify_lookup_order')).toHaveLength(1);
    // non-secret field baked into the URL via the stored secret value
    const shopifyTool = agent.config.tools.find(
      (t: { name: string }) => t.name === 'shopify_lookup_order',
    );
    expect(shopifyTool.url).toContain('{{secrets.SHOPIFY_SHOP}}');
  });

  it('rejects missing required fields without storing anything', async () => {
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'zendesk', fields: { subdomain: 'acme' } }),
    });
    expect(res.status).toBe(400);
    const secrets = await (
      await app.request(`/api/agents/${id}/secrets`, { headers: { cookie: parentCookie } })
    ).json();
    expect(secrets.secrets).toHaveLength(0);
  });

  it('uninstall removes the template tools but keeps the secrets', async () => {
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'itunes', fields: {} }),
    });
    const res = await app.request(`/api/agents/${id}/tools/itunes`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    expect(agent.config.tools ?? []).toHaveLength(0);
  });

  it('oauth template mints a token at install and stores a connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'tok_xyz', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        template: 'zendesk-oauth',
        fields: { subdomain: 'acme', client_id: 'cid', client_secret: 'csec' },
      }),
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    const names = agent.config.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('zendesk_oauth_search');
    const [conn] = await db.select().from(agentConnections).where(eq(agentConnections.agentId, id));
    expect(conn.provider).toBe('zendesk-oauth');
    expect(conn.accessTokenEnc).toBeTruthy();
    // uninstall drops the connection row too
    await app.request(`/api/agents/${id}/tools/zendesk-oauth`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(
      await db.select().from(agentConnections).where(eq(agentConnections.agentId, id)),
    ).toHaveLength(0);
  });

  it('oauth install fails cleanly when the provider rejects the credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
      ),
    );
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        template: 'salesforce',
        fields: { instance: 'acme.my.salesforce.com', client_id: 'bad', client_secret: 'bad' },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('could not authenticate');
    expect(
      await db.select().from(agentConnections).where(eq(agentConnections.agentId, id)),
    ).toHaveLength(0);
  });
});

describe('llm config', () => {
  afterEach(() => vi.unstubAllGlobals());
  const newAgentId = async () => {
    const res = await postAgent(parentCookie);
    return (await res.json()).agent.id as string;
  };
  const patch = (id: string, config: unknown) =>
    app.request(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ config }),
    });
  const storedLlm = async (id: string) => {
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, id));
    return ((row.config as { llm?: Record<string, unknown> })?.llm ?? {}) as Record<
      string,
      unknown
    >;
  };

  it('write-only key: reads return key_set, never the key', async () => {
    const id = await newAgentId();
    const res = await patch(id, {
      llm: { provider: 'openai', api_key: 'sk-live-secret', model: 'gpt-6-sol' },
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    expect(agent.config.llm.api_key).toBeUndefined();
    expect(agent.config.llm.key_set).toBe(true);
    // …but the stored config keeps the real key for the hosted runtime
    expect((await storedLlm(id)).api_key).toBe('sk-live-secret');
  });

  it('a config save without api_key preserves the stored key; null clears it', async () => {
    const id = await newAgentId();
    await patch(id, { llm: { provider: 'openai', api_key: 'sk-keep-me' } });
    await patch(id, { llm: { provider: 'openai', model: 'gpt-6-luna' } });
    expect((await storedLlm(id)).api_key).toBe('sk-keep-me');
    expect((await storedLlm(id)).model).toBe('gpt-6-luna');
    await patch(id, { llm: { provider: 'janis', api_key: null } });
    const llm = await storedLlm(id);
    expect(llm.api_key).toBeUndefined();
    expect(llm.provider).toBe('janis');
  });

  it('llm-models lists models from the metered env endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/llm-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ metered: true }),
    });
    expect((await res.json()).models).toEqual(['a-model', 'b-model']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: {} }),
    );
  });

  it('llm-models never sends the env key to a custom endpoint — uses the stored key', async () => {
    const id = await newAgentId();
    await patch(id, {
      llm: { provider: 'groq', base_url: 'https://api.groq.com/openai/v1', api_key: 'gsk_saved' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request(`/api/agents/${id}/llm-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      // caller sends only the endpoint — server should fill the saved key
      body: JSON.stringify({ base_url: 'https://api.groq.com/openai/v1' }),
    });
    expect((await res.json()).models).toEqual(['m1']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer gsk_saved' } }),
    );
  });

  it('llm-models with an unknown endpoint and no key calls it unauthenticated', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/llm-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ base_url: 'https://llm.example.com/v1' }),
    });
    expect((await res.json()).error).toContain('401');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm.example.com/v1/models',
      expect.objectContaining({ headers: {} }),
    );
  });
});
