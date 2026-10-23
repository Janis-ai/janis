import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agentConnections, agentSecrets, agents, agentTests, channelBindings, channels, conversations, knowledgeFiles, memberships, messages, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { generateKeyPairSync } from 'node:crypto';
import { encryptSecret } from '../lib/secrets.js';
import { setStripeClient } from '../lib/stripe.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { env } from '../env.js';
import { toolsFor } from '../lib/toolExec.js';
import { agentRoutes } from './agents.js';

let app: Hono;
let db: Db;
let childCookie: string;
let parentCookie: string;

let botSeq = 0;
const postAgent = (cookie: string) =>
  app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: `New Bot ${++botSeq}` }),
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

  it('a config PATCH preserves every tool field — bodyTemplate, identity, widget.relevance', async () => {
    // Prod incident: the AgentConfig zod dropped bodyTemplate (and identity /
    // label / widget.relevance) on any config save, so the stored Shopify
    // tools shipped flat-arg bodies and every GraphQL call parse-failed.
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'shopify', fields: { shop: 'mystore', token: 'shpat_test' } }),
    });
    const list = await (
      await app.request('/api/agents', { headers: { cookie: parentCookie } })
    ).json();
    const cfg = list.agents.find((a: { id: string }) => a.id === id).config;
    const res = await app.request(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ config: { ...cfg, tone: 'warm' } }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, id));
    const tools = (row.config as { tools: Record<string, unknown>[] }).tools;
    const search = tools.find((t) => t.name === 'shopify_search_products')!;
    expect(search.bodyTemplate).toContain('${query:text}');
    expect(search.label).toBe('Search products');
    const custOrders = tools.find((t) => t.name === 'shopify_customer_orders')!;
    expect(custOrders.identity).toBe(true);
    expect((search.widget as { map: Record<string, string> }).map.link).toContain('{handle}');
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

  it('removing via a sibling template drops an orphaned OAuth connection', async () => {
    // OAuth-Calendly tools and the PAT-Calendly card share tool names —
    // removing through the PAT card (which has no connection of its own)
    // must still retire the calendly grant or it keeps minting on every run.
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'calendly-connect', fields: {} }),
    });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, id));
    await db.insert(agentConnections).values({
      agentId: id,
      workspaceId: agentRow.workspaceId,
      provider: 'calendly',
      credentialsEnc: encryptSecret(JSON.stringify({ refresh_token: 'r1' })),
    });
    const res = await app.request(`/api/agents/${id}/tools/calendly`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    expect(
      await db.select().from(agentConnections).where(eq(agentConnections.agentId, id)),
    ).toHaveLength(0);
  });

  it('uninstall keeps a connection a custom tool still references', async () => {
    const id = await newAgentId();
    const res = await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'calendly-connect', fields: {} }),
    });
    const { agent } = await res.json();
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, id));
    await db.insert(agentConnections).values({
      agentId: id,
      workspaceId: agentRow.workspaceId,
      provider: 'calendly',
      credentialsEnc: encryptSecret(JSON.stringify({ refresh_token: 'r1' })),
    });
    // Swap the template tools for a hand-built one that still mints via CONN_.
    await db
      .update(agents)
      .set({
        config: {
          ...agent.config,
          tools: [
            {
              name: 'my_calendly_ping',
              method: 'GET',
              url: 'https://api.calendly.com/users/me',
              headers: { authorization: 'Bearer {{secrets.CONN_CALENDLY_TOKEN}}' },
            },
          ],
        },
      })
      .where(eq(agents.id, id));
    await app.request(`/api/agents/${id}/tools/calendly-connect`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(
      await db.select().from(agentConnections).where(eq(agentConnections.agentId, id)),
    ).toHaveLength(1);
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

  it('stamps installed tools with the template id so the UI manages them', async () => {
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'itunes', fields: {} }),
    });
    const list = await (
      await app.request('/api/agents', { headers: { cookie: parentCookie } })
    ).json();
    const agent = list.agents.find((a: { id: string }) => a.id === id);
    expect(
      agent.config.tools.every(
        (t: { template?: string }) => t.template === 'itunes',
      ),
    ).toBe(true);
  });

  it('toggles approval per tool via PATCH /tools/:template', async () => {
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        template: 'shopify',
        fields: { shop: 'mystore', token: 'shpat_test' },
      }),
    });
    const res = await app.request(`/api/agents/${id}/tools/shopify`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        approvals: { shopify_cancel_order: false, shopify_lookup_order: true },
      }),
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    const byName = (n: string) =>
      agent.config.tools.find((t: { name: string }) => t.name === n);
    // un-gated a write; gated a read — the trust dial is per action
    expect(byName('shopify_cancel_order').approval).toBeUndefined();
    expect(byName('shopify_lookup_order').approval).toBe(true);
    // not in the map → untouched (ungated by catalog default)
    expect(byName('shopify_create_draft_order').approval).toBeUndefined();
  });

  it('toggles disabled per tool via PATCH /tools/:template', async () => {
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        template: 'shopify',
        fields: { shop: 'mystore', token: 'shpat_test' },
      }),
    });
    const res = await app.request(`/api/agents/${id}/tools/shopify`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        disabled: { shopify_list_collections: true, shopify_lookup_order: false },
      }),
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    const byName = (n: string) =>
      agent.config.tools.find((t: { name: string }) => t.name === n);
    expect(byName('shopify_list_collections').disabled).toBe(true);
    expect(byName('shopify_lookup_order').disabled).toBeUndefined();
    // toolsFor hides disabled tools from the model but keeps them configured
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    const names = toolsFor(row).map((t) => t.name);
    expect(names).toContain('shopify_lookup_order');
    expect(names).not.toContain('shopify_list_collections');
  });

  it('PATCH manages legacy installs by name and stamps the marker', async () => {
    const id = await newAgentId();
    // simulate a pre-marker install: same tool names, no `template` field
    const [before] = await db.select().from(agents).where(eq(agents.id, id));
    await db
      .update(agents)
      .set({
        config: {
          ...(before.config ?? {}),
          tools: [
            {
              name: 'itunes_search',
              description: 'legacy install',
              method: 'GET',
              url: 'https://itunes.apple.com/search?term={term}',
              params: { term: 'search' },
            },
          ],
        },
      })
      .where(eq(agents.id, id));
    const res = await app.request(`/api/agents/${id}/tools/itunes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ approvals: { itunes_search: true } }),
    });
    expect(res.status).toBe(200);
    const { agent } = await res.json();
    expect(agent.config.tools[0].approval).toBe(true);
    expect(agent.config.tools[0].template).toBe('itunes');
  });

  it('PATCH never touches tools outside the template', async () => {
    const id = await newAgentId();
    await app.request(`/api/agents/${id}/tools/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ template: 'itunes', fields: {} }),
    });
    const [before] = await db.select().from(agents).where(eq(agents.id, id));
    await db
      .update(agents)
      .set({
        config: {
          ...(before.config ?? {}),
          tools: [
            ...(before.config?.tools ?? []),
            {
              name: 'my_custom_tool',
              description: 'hand-written',
              method: 'GET',
              url: 'https://example.com/{x}',
              approval: true,
            },
          ],
        },
      })
      .where(eq(agents.id, id));
    // even if the request names a foreign tool, it's scoped to the template
    await app.request(`/api/agents/${id}/tools/itunes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ approvals: { my_custom_tool: false } }),
    });
    const list = await (
      await app.request('/api/agents', { headers: { cookie: parentCookie } })
    ).json();
    const agent = list.agents.find((a: { id: string }) => a.id === id);
    const custom = agent.config.tools.find(
      (t: { name: string }) => t.name === 'my_custom_tool',
    );
    expect(custom.approval).toBe(true);
    expect(custom.template).toBeUndefined();
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
    const body = await res.json();
    expect(body.models).toEqual(['a-model', 'b-model']);
    // accounts expose which vendor Janis's env key serves — the UI filters
    // the hosted model picker on it
    expect(body.accounts).toEqual([
      expect.objectContaining({ vendor: 'openai', models: ['a-model', 'b-model'] }),
    ]);
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

  it('free plan locks the hosted model — default and BYOK stay open', async () => {
    const [free] = await db
      .insert(workspaces)
      .values({ name: 'Free WS', plan: 'free' })
      .returning();
    const freeCookie = await cookieFor(free.id, 'free@x.test');
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({ name: 'FreeBot' }),
    });
    const id = (await res.json()).agent.id as string;
    const patch = (config: unknown) =>
      app.request(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: freeCookie },
        body: JSON.stringify({ config }),
      });

    // switching the hosted model → 402
    const locked = await patch({ llm: { provider: 'janis', model: 'claude-sonnet-4-6' } });
    expect(locked.status).toBe(402);
    expect((await locked.json()).llm_locked).toBe(true);

    // picking the env default is always allowed — the lock can't trap anyone
    expect(
      (await patch({ llm: { provider: 'janis', model: env.llmModel } })).status,
    ).toBe(200);
    // unrelated llm fields (effort etc.) still save
    expect((await patch({ llm: { provider: 'janis', effort: 'high' } })).status).toBe(
      200,
    );
    // BYOK is exempt — the customer pays the provider
    expect(
      (
        await patch({
          llm: { provider: 'openai', api_key: 'sk-x', model: 'gpt-6-sol' },
        })
      ).status,
    ).toBe(200);
    // upgrading lifts the gate
    await db.update(workspaces).set({ plan: 'pro' }).where(eq(workspaces.id, free.id));
    expect(
      (await patch({ llm: { provider: 'janis', model: 'claude-sonnet-4-6' } })).status,
    ).toBe(200);
  });
});

describe('slack_routes PATCH', () => {
  it('null clears routes back to inheriting the workspace default', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [agent] = await db
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    const [inst] = await db
      .insert(schema.slackInstallations)
      .values({ workspaceId: agent.workspaceId, teamId: 'T_NULL', botToken: 'xoxb-null' })
      .returning();
    await db
      .update(schema.agents)
      .set({ slackRoutes: [{ installation_id: inst.id, channel_id: 'C1' }] })
      .where(eq(schema.agents.id, agentId));

    const patch = await app.request(`/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ slack_routes: null }),
    });
    expect(patch.status).toBe(200);
    const [stored] = await db
      .select({ routes: schema.agents.slackRoutes })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    expect(stored.routes).toBeNull();

    // and the serialized agent says "inherit"
    const get = await app.request('/api/agents', {
      headers: { cookie: parentCookie },
    });
    const found = (await get.json()).agents.find((a: { id: string }) => a.id === agentId);
    expect(found.slack_routes).toBeNull();
  });

  it('[] sticks as explicitly muted', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const patch = await app.request(`/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ slack_routes: [] }),
    });
    expect(patch.status).toBe(200);
    const [stored] = await db
      .select({ routes: schema.agents.slackRoutes })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    expect(stored.routes).toEqual([]);
  });
});

describe('slack_routes channel validation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('rejects a route pointing at an archived channel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, channel: { id: 'C_DEAD', name: 'dead', is_archived: true } }),
            { status: 200 },
          ),
        ),
      ),
    );
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [agent] = await db
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    const [inst] = await db
      .insert(schema.slackInstallations)
      .values({ workspaceId: agent.workspaceId, teamId: 'T_ARCH', botToken: 'xoxb-arch' })
      .returning();
    const patch = await app.request(`/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        slack_routes: [{ installation_id: inst.id, channel_id: 'C_DEAD' }],
      }),
    });
    expect(patch.status).toBe(400);
    expect((await patch.json()).error).toContain('archived');
  });
});

describe('knowledge-gaps approve', () => {
  it('splits multi-line drafts into separate entries and strips markdown', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const approve = await app.request(`/api/agents/${agentId}/knowledge-gaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        entry:
          '**Adding a New Agent**\n\nTo add a new team member, go to Settings > Team and select Invite Agent.\n- Agents each get their own knowledge base.',
      }),
    });
    expect(approve.status).toBe(200);
    const body = await approve.json();
    expect(body.agent.config.knowledge).toEqual([
      'Adding a New Agent',
      'To add a new team member, go to Settings > Team and select Invite Agent.',
      'Agents each get their own knowledge base.',
    ]);
  });

  it('dedupes lines already in the knowledge base', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const approve = (entry: string) =>
      app.request(`/api/agents/${agentId}/knowledge-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: parentCookie },
        body: JSON.stringify({ entry }),
      });
    await approve('Refunds are accepted within 30 days.');
    const second = await approve('Refunds are accepted within 30 days.\nShipping is flat-rate.');
    const body = await second.json();
    expect(body.agent.config.knowledge).toEqual([
      'Refunds are accepted within 30 days.',
      'Shipping is flat-rate.',
    ]);
  });
});

describe('save-as-test splits at rescue points', () => {
  it('creates one test per customer prompt that preceded a human intervention', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:vis_split' })
      .returning();
    const seq = (i: number) => new Date(1_700_000_000_000 + i * 1000);
    const inserted = await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'how do refunds work?', createdAt: seq(0) },
      { conversationId: conv.id, direction: 'out', text: 'within 30 days', createdAt: seq(1) },
      { conversationId: conv.id, direction: 'in', text: 'what about shipping to France?', createdAt: seq(2) },
      // operator answered — checkpoint #1 (the customer turn before it)
      { conversationId: conv.id, direction: 'human', text: 'yes we ship to France', createdAt: seq(3) },
      { conversationId: conv.id, direction: 'in', text: 'and bulk discounts?', createdAt: seq(4) },
      // failure flag → "(passed to a human teammate)" — checkpoint #2
      { conversationId: conv.id, direction: 'out', text: 'let me get help', flags: { failure: true }, createdAt: seq(5) },
      { conversationId: conv.id, direction: 'in', text: 'ok thanks', createdAt: seq(6) },
      { conversationId: conv.id, direction: 'out', text: 'anytime!', createdAt: seq(7) },
    ]).returning();
    const res2 = await app.request(`/api/agents/${agentId}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        name: 'rescue transcript',
        expectation: 'handles without a human',
        conversation_id: conv.id,
      }),
    });
    expect(res2.status).toBe(201);
    const body = await res2.json();
    expect(body.tests).toHaveLength(2);
    expect(body.tests[0].name).toBe('rescue transcript #1');
    expect(body.tests[0].turns.at(-1).text).toBe('what about shipping to France?');
    expect(body.tests[1].name).toBe('rescue transcript #2');
    expect(body.tests[1].turns.at(-1).text).toBe('and bulk discounts?');
    // deep-link target: each test points at the customer message it replays
    const byText = Object.fromEntries(inserted.map((m) => [m.text, m.id]));
    expect(body.tests[0].source_message_id).toBe(byText['what about shipping to France?']);
    expect(body.tests[1].source_message_id).toBe(byText['and bulk discounts?']);
    // each test keeps what actually happened next in the real conversation
    expect(body.tests[0].original_reply).toBe('(human operator) yes we ship to France');
    expect(body.tests[1].original_reply).toBe('(passed to a human teammate)');
  });

  it('falls back to one test on the last customer message when nothing escalated', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:vis_clean' })
      .returning();
    const seq = (i: number) => new Date(1_700_000_000_000 + i * 1000);
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'hi', createdAt: seq(0) },
      { conversationId: conv.id, direction: 'out', text: 'hello!', createdAt: seq(1) },
      { conversationId: conv.id, direction: 'in', text: 'hours?', createdAt: seq(2) },
      { conversationId: conv.id, direction: 'out', text: '9 to 5', createdAt: seq(3) },
    ]);
    const res2 = await app.request(`/api/agents/${agentId}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        name: 'clean transcript',
        expectation: 'answers politely',
        conversation_id: conv.id,
      }),
    });
    expect(res2.status).toBe(201);
    const body = await res2.json();
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0].name).toBe('clean transcript');
    expect(body.tests[0].turns.at(-1).text).toBe('hours?');
  });

  it('ignores courtesy handoff offers that follow a real answer', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:vis_offer' })
      .returning();
    const seq = (i: number) => new Date(1_700_000_000_000 + i * 1000);
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'how does billing work?', createdAt: seq(0) },
      // agent answered, THEN offered a human — courtesy, not a rescue
      { conversationId: conv.id, direction: 'out', text: 'Stripe handles it — want a human anyway?', createdAt: seq(1) },
      { conversationId: conv.id, direction: 'out', text: 'Offered a human: awaiting reply', flags: { handoff_offer: true }, createdAt: seq(2) },
      // a bare offer directly after a customer turn IS a deflection → checkpoint
      { conversationId: conv.id, direction: 'in', text: 'what about enterprise?', createdAt: seq(3) },
      { conversationId: conv.id, direction: 'out', text: 'Offered a human: awaiting reply', flags: { handoff_offer: true }, createdAt: seq(4) },
    ]);
    const res2 = await app.request(`/api/agents/${agentId}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({
        name: 'offers',
        expectation: 'answers directly',
        conversation_id: conv.id,
      }),
    });
    expect(res2.status).toBe(201);
    const body = await res2.json();
    // only the bare-deflection prompt is a checkpoint — not the answered one
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0].turns.at(-1).text).toBe('what about enterprise?');
  });
});

describe('DELETE /agents/:id', () => {
  it('cascades through conversations, channels, and agent-scoped rows', async () => {
    const res = await postAgent(parentCookie);
    const agentId = (await res.json()).agent.id as string;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'webchat:vis_del' })
      .returning();
    await db.insert(messages).values([
      { conversationId: conv.id, direction: 'in', text: 'hi' },
      { conversationId: conv.id, direction: 'out', text: 'hello' },
    ]);
    // a saved test referencing the conversation (source ids are plain uuids)
    await app.request(`/api/agents/${agentId}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ name: 't', expectation: 'e', conversation_id: conv.id }),
    });
    // test channel + binding — the rows a used agent actually has
    const [chan] = await db
      .insert(channels)
      .values({
        workspaceId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0].workspaceId,
        agentId,
        kind: 'webchat',
        name: 'Test channel',
        credentials: { internal: true },
      })
      .returning();
    await db
      .insert(channelBindings)
      .values({ channelId: chan.id, conversationId: conv.id, platformUserId: 'vis_del' });
    const del = await app.request(`/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(del.status).toBe(200);
    const [gone] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(gone).toBeUndefined();
    const convs = await db.select().from(conversations).where(eq(conversations.agentId, agentId));
    expect(convs).toHaveLength(0);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs).toHaveLength(0);
    const chans = await db.select().from(channels).where(eq(channels.agentId, agentId));
    expect(chans).toHaveLength(0);
    const binds = await db.select().from(channelBindings).where(eq(channelBindings.channelId, chan.id));
    expect(binds).toHaveLength(0);
  });
});

describe('knowledge-import', () => {
  afterEach(() => vi.unstubAllGlobals());

  const newAgent = async () => {
    const res = await postAgent(parentCookie);
    return (await res.json()).agent.id as string;
  };
  const post = (id: string, url: string) =>
    app.request(`/api/agents/${id}/knowledge-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ url }),
    });
  const rows = (id: string) =>
    db.select().from(knowledgeFiles).where(eq(knowledgeFiles.agentId, id));

  it('imports a Zendesk centre via the articles API, deduping on re-import', async () => {
    const id = await newAgent();
    const pages: Record<string, unknown> = {
      'https://acme.zendesk.com/api/v2/help_center/en-us/articles.json?per_page=100': {
        articles: [
          {
            html_url: 'https://acme.zendesk.com/hc/en-us/articles/1-returns',
            title: 'Returns',
            body: '<p>Return <b>within 30 days</b>.</p>',
          },
          {
            html_url: 'https://acme.zendesk.com/hc/en-us/articles/2-shipping',
            title: 'Shipping',
            body: '<p>Ships in 2 days.</p>',
          },
          { html_url: 'https://acme.zendesk.com/hc/en-us/articles/9-draft', title: 'Draft', draft: true },
        ],
        next_page:
          'https://acme.zendesk.com/api/v2/help_center/en-us/articles.json?page=2&per_page=100',
      },
      'https://acme.zendesk.com/api/v2/help_center/en-us/articles.json?page=2&per_page=100': {
        articles: [
          {
            html_url: 'https://acme.zendesk.com/hc/en-us/articles/3-warranty',
            title: 'Warranty',
            body: '<p>Two years.</p>',
          },
        ],
        next_page: null,
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: unknown) => {
        const page = pages[String(u)];
        return page
          ? new Response(JSON.stringify(page), { status: 200 })
          : new Response('not found', { status: 404 });
      }),
    );
    const res = await post(id, 'https://acme.zendesk.com/hc/en-us');
    expect(res.status).toBe(201);
    const body = await res.json();
    // drafts skipped; both pages walked
    expect(body).toMatchObject({ kind: 'zendesk', discovered: 3, imported: 3, skipped: 0 });
    const files = await rows(id);
    expect(files.map((f) => f.name).sort()).toEqual(['Returns', 'Shipping', 'Warranty']);
    const ret = files.find((f) => f.name === 'Returns')!;
    expect(ret.sourceUrl).toBe('https://acme.zendesk.com/hc/en-us/articles/1-returns');
    expect(ret.text).toContain('within 30 days');
    expect(ret.text).not.toContain('<b>');
    // normal URL-source cadence — the sweeper re-crawls it
    expect(ret.nextFetchAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 3600_000);

    const again = await post(id, 'https://acme.zendesk.com/hc/en-us');
    expect((await again.json()).skipped).toBe(3);
    expect(await rows(id)).toHaveLength(3);
  });

  it('falls back to the sitemap and queues stub rows scoped to the pasted path', async () => {
    const id = await newAgent();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: unknown) => {
        const url = String(u);
        if (url.includes('/api/v2/help_center')) return new Response('no', { status: 404 });
        if (url.endsWith('/robots.txt'))
          return new Response('User-agent: *\nSitemap: https://help.acme.com/map.xml', {
            status: 200,
          });
        if (url.endsWith('/map.xml'))
          return new Response(
            '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
              '<url><loc>https://help.acme.com/en/returns</loc></url>' +
              '<url><loc>https://help.acme.com/en/shipping</loc></url>' +
              '<url><loc>https://help.acme.com/fr/retours</loc></url>' +
              '<url><loc>https://other.example.com/x</loc></url>' +
              '</urlset>',
            { status: 200 },
          );
        return new Response('no', { status: 404 });
      }),
    );
    const res = await post(id, 'https://help.acme.com/en');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ kind: 'sitemap', discovered: 2, queued: 2 });
    const files = await rows(id);
    expect(files.map((f) => f.sourceUrl).sort()).toEqual([
      'https://help.acme.com/en/returns',
      'https://help.acme.com/en/shipping',
    ]);
    // stubs — no text yet, due immediately so the sweeper fills them
    expect(files[0].text).toBe('');
    expect(files[0].nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('crawls links when there is no sitemap, staying in scope', async () => {
    const id = await newAgent();
    const html = (links: string[]) =>
      `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`;
    const pages: Record<string, string> = {
      'https://docs.acme.com/guide': html([
        '/guide/start',
        '/guide/setup',
        'https://docs.acme.com/guide/start#top', // fragment dedupe
        '/guide/start?utm_source=x', // query dedupe
        '/blog/post', // outside the /guide scope
        'https://other.example.com/guide/x', // off-host
        '/guide/logo.png', // asset
        'mailto:a@acme.com',
      ]),
      'https://docs.acme.com/guide/start': html(['/guide/start/install', '/guide']),
      'https://docs.acme.com/guide/setup': html([]),
      'https://docs.acme.com/guide/start/install': html([]),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: unknown) => {
        const url = String(u);
        if (url.includes('/api/v2/help_center')) return new Response('no', { status: 404 });
        if (url.endsWith('/robots.txt') || url.endsWith('/sitemap.xml'))
          return new Response('no', { status: 404 });
        const body = pages[url];
        return body !== undefined
          ? new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response('no', { status: 404 });
      }),
    );
    const res = await post(id, 'https://docs.acme.com/guide');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('crawl');
    const files = await rows(id);
    expect(files.map((f) => f.sourceUrl).sort()).toEqual([
      'https://docs.acme.com/guide',
      'https://docs.acme.com/guide/setup',
      'https://docs.acme.com/guide/start',
      'https://docs.acme.com/guide/start/install',
    ]);
  });

  it('follows sitemap index files', async () => {
    const id = await newAgent();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: unknown) => {
        const url = String(u);
        if (url.includes('/api/v2/help_center')) return new Response('no', { status: 404 });
        if (url.endsWith('/robots.txt')) return new Response('no', { status: 404 });
        if (url.endsWith('/sitemap.xml'))
          return new Response(
            '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
              '<sitemap><loc>https://kb.acme.com/sitemap-help.xml</loc></sitemap>' +
              '</sitemapindex>',
            { status: 200 },
          );
        if (url.endsWith('/sitemap-help.xml'))
          return new Response(
            '<urlset><url><loc>https://kb.acme.com/help/refunds</loc></url></urlset>',
            { status: 200 },
          );
        return new Response('no', { status: 404 });
      }),
    );
    const res = await post(id, 'https://kb.acme.com/help');
    const body = await res.json();
    expect(body).toMatchObject({ kind: 'sitemap', queued: 1 });
    const files = await rows(id);
    expect(files[0].sourceUrl).toBe('https://kb.acme.com/help/refunds');
  });

  it('422s when the site is neither Zendesk, sitemap- nor crawl-discoverable', async () => {
    const id = await newAgent();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    const res = await post(id, 'https://acme.com');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('no pages found');
    expect(await rows(id)).toHaveLength(0);
  });
});

describe('knowledge patch + bulk delete', () => {
  const newAgent = async () => {
    const res = await postAgent(parentCookie);
    return (await res.json()).agent.id as string;
  };
  const addFile = async (
    agentId: string,
    over: Partial<typeof knowledgeFiles.$inferInsert> = {},
  ) => {
    const [a] = await db
      .select({ workspaceId: agents.workspaceId })
      .from(agents)
      .where(eq(agents.id, agentId));
    const [r] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId: a.workspaceId,
        agentId,
        name: 'https://x.example/page',
        mimeType: 'text/url-source',
        sizeBytes: 12,
        text: 'some content',
        sourceUrl: 'https://x.example/page',
        refreshHours: 24,
        nextFetchAt: new Date(),
        ...over,
      })
      .returning();
    return r;
  };
  const patch = (id: string, fileId: string, body: unknown) =>
    app.request(`/api/agents/${id}/knowledge/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify(body),
    });

  it('PATCH refresh_hours toggles the re-crawl schedule', async () => {
    const id = await newAgent();
    const f = await addFile(id);

    let res = await patch(id, f.id, { refresh_hours: null });
    expect(res.status).toBe(200);
    let [row] = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.id, f.id));
    expect(row.refreshHours).toBeNull();
    expect(row.nextFetchAt).toBeNull();

    res = await patch(id, f.id, { refresh_hours: 48 });
    expect(res.status).toBe(200);
    [row] = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.id, f.id));
    expect(row.refreshHours).toBe(48);
    expect(row.nextFetchAt?.getTime()).toBeGreaterThan(Date.now());

    // enabled still works alongside the new field
    res = await patch(id, f.id, { enabled: false });
    expect(res.status).toBe(200);
    [row] = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.id, f.id));
    expect(row.enabled).toBe(false);
    expect(row.refreshHours).toBe(48);
  });

  it('GET one file returns its stored text — list stays metadata-only', async () => {
    const id = await newAgent();
    const f = await addFile(id, { name: 'Knowledge from Jerry Garcia', text: 'persona note text' });
    const other = await newAgent();
    const alien = await addFile(other);

    const listRes = await app.request(`/api/agents/${id}/knowledge`, {
      headers: { cookie: parentCookie },
    });
    const list = await listRes.json();
    expect(list.files[0].text).toBeUndefined();
    expect(list.files[0].chars).toBe(17);

    const res = await app.request(`/api/agents/${id}/knowledge/${f.id}`, {
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('persona note text');
    expect(body.chars).toBe(17);
    expect(body.source_url).toBe('https://x.example/page');

    // another agent's file isn't readable through this agent's path
    const alienRes = await app.request(`/api/agents/${id}/knowledge/${alien.id}`, {
      headers: { cookie: parentCookie },
    });
    expect(alienRes.status).toBe(404);
  });

  it('bulk-delete removes only this agent\'s listed files', async () => {
    const id = await newAgent();
    const other = await newAgent();
    const f1 = await addFile(id);
    const f2 = await addFile(id, { name: 'second' });
    const keep = await addFile(id, { name: 'keep me' });
    const alien = await addFile(other);

    const res = await app.request(`/api/agents/${id}/knowledge/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ ids: [f1.id, f2.id, alien.id] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(2);

    const remaining = await db
      .select({ id: knowledgeFiles.id })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, id));
    expect(remaining.map((r) => r.id)).toEqual([keep.id]);
    const [alienRow] = await db
      .select()
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.id, alien.id));
    expect(alienRow).toBeTruthy();
  });
});

describe('agent list ordering', () => {
  it('returns agents alphabetically regardless of creation order', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Sort WS' }).returning();
    const cookie = await cookieFor(ws.id, 'sort@x.test');
    for (const [i, name] of ['zeta bot', 'Alpha bot', 'mango bot'].entries()) {
      await db.insert(agents).values({
        workspaceId: ws.id, name, apiKeyHash: `h${i}`, apiKeyPreview: 'p',
      });
    }
    const list = await (
      await app.request('/api/agents', { headers: { cookie } })
    ).json();
    expect(list.agents.map((a: { name: string }) => a.name)).toEqual([
      'Alpha bot',
      'mango bot',
      'zeta bot',
    ]);
  });
});

describe('agent bootstrap (guided builder)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.llmApiKey = '';
  });

  const bootstrap = (body: Record<string, unknown>) =>
    app.request('/api/agents/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify(body),
    });

  it('creates a hosted agent with a generated draft config', async () => {
    env.llmApiKey = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    name: 'Shop Support',
                    system_prompt:
                      'You are the support agent for Acme Store. Answer order and shipping questions. Offer a human when the customer asks for one.',
                    tone: 'warm, concise, never apologetic',
                    greeting: 'Hi! How can I help with your order today?',
                    suggested_knowledge: [
                      'Refunds under $50 are approved within 24h',
                      'Standard shipping takes 3-5 business days',
                    ],
                    suggested_templates: [
                      { id: 'shopify', reason: 'order lookups and refunds' },
                      { id: 'totally_invented', reason: 'hallucinated id' },
                    ],
                    suggested_approvals: ['issue refund', 'cancel order'],
                    suggested_rules: ['offer a human when the customer asks twice'],
                  }),
                },
              },
            ],
          }),
        ),
      ),
    );

    const res = await bootstrap({
      purpose: 'customer support agent for my ecommerce store — orders, shipping, refunds',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.draft.generated).toBe(true);
    const agent = body.agent;
    expect(agent.name).toBe('Shop Support'); // draft name used — none supplied
    expect(agent.hosted).toBe(true);
    expect(agent.config.system_prompt).toContain('support agent for Acme Store');
    expect(agent.config.tone).toBe('warm, concise, never apologetic');
    expect(agent.config.greeting).toContain('How can I help');
    expect(agent.config.greeting_enabled).toBe(true);
    expect(agent.config.purpose).toContain('ecommerce');
    // hallucinated template id dropped; the real one kept with reason+name —
    // plus the Brave live-search floor every knowledge-needing agent gets
    expect(agent.config.builder.suggested_templates.map((t: { id: string }) => t.id))
      .toEqual(['shopify', 'brave']);
    expect(agent.config.builder.suggested_approvals).toContain('issue refund');
    expect(agent.config.builder.suggested_knowledge).toHaveLength(2);
  });

  it('creates a minimal agent when the LLM is unavailable — creation never blocks', async () => {
    env.llmApiKey = ''; // no platform key → no draft
    const res = await bootstrap({ name: 'Plain Bot', purpose: 'answers faq' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe('Plain Bot');
    expect(body.draft.generated).toBe(false);
    expect(body.draft.note).toContain('LLM');
    expect(body.agent.config.purpose).toBe('answers faq');
  });

  it('creates a blank agent with no purpose at all', async () => {
    const res = await bootstrap({ name: 'Empty Bot' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe('Empty Bot');
    expect(body.draft.generated).toBe(false);
  });

  it('honours the agency gate like plain creation', async () => {
    const res = await app.request('/api/agents/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: childCookie },
      body: JSON.stringify({ purpose: 'anything' }),
    });
    expect(res.status).toBe(402);
  });
});

describe('try-it scenarios', () => {
  afterEach(() => vi.unstubAllGlobals());
  const mkAgent = async () => {
    const res = await postAgent(parentCookie);
    return (await res.json()).agent.id as string;
  };
  const postTest = (id: string, body: Record<string, unknown>) =>
    app.request(`/api/agents/${id}/tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify(body),
    });
  const listTests = (id: string) =>
    app.request(`/api/agents/${id}/tests`, { headers: { cookie: parentCookie } });
  const patchTest = (id: string, testId: string, body: Record<string, unknown>) =>
    app.request(`/api/agents/${id}/tests/${testId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify(body),
    });
  const buildStatus = async (id: string) =>
    (
      await (
        await app.request(`/api/agents/${id}/build-status`, {
          headers: { cookie: parentCookie },
        })
      ).json()
    ) as {
      steps: { try: string; abilities: string };
      test_scenarios: {
        total: number;
        checked: number;
        passing: number;
        failing: number;
        unrun: number;
        stale: number;
        safety_total: number;
        safety_checked: number;
      };
    };
  const patchConfig = (id: string, config: Record<string, unknown>) =>
    app.request(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: parentCookie },
      body: JSON.stringify({ config }),
    });

  it('creates a single-turn scenario via the prompt shorthand', async () => {
    const id = await mkAgent();
    const res = await postTest(id, {
      prompt: 'what are your office hours?',
      expectation: 'states the real office hours',
      category: 'knowledge',
      source: 'correction',
    });
    expect(res.status).toBe(201);
    const t = (await res.json()).test;
    expect(t.name).toBe('what are your office hours?');
    expect(t.turns).toEqual([{ role: 'customer', text: 'what are your office hours?' }]);
    expect(t.category).toBe('knowledge');
    expect(t.source).toBe('correction');
    expect(t.human_result).toBeNull();
    expect(t.stale).toBe(false);
  });

  it('records panel verdicts and marks them stale after a config change', async () => {
    const id = await mkAgent();
    const created = await (
      await postTest(id, { prompt: 'hours?', expectation: 'answers with real hours' })
    ).json();
    const tid = created.test.id as string;
    const verdict = await patchTest(id, tid, { human_result: 'pass' });
    expect(verdict.status).toBe(200);
    const v = (await verdict.json()).test;
    expect(v.human_result).toBe('pass');
    expect(v.human_run_at).toBeTruthy();
    expect(v.stale).toBe(false);

    // A config edit changes the fingerprint — the verdict is now stale.
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    const cfg = (agent.config ?? {}) as Record<string, unknown>;
    const res = await patchConfig(id, {
      ...cfg,
      knowledge: ['we are closed on Sundays'],
    });
    expect(res.status).toBe(200);
    const listed = await (await listTests(id)).json();
    expect(listed.tests[0].stale).toBe(true);

    // The status aggregates — checked, stale, step ◐.
    const st = await buildStatus(id);
    expect(st.test_scenarios.total).toBe(1);
    expect(st.test_scenarios.checked).toBe(1);
    expect(st.test_scenarios.stale).toBe(1);
    expect(st.steps.try).toBe('partial');
  });

  it('seeds suggested_scenarios from the draft, idempotently', async () => {
    const id = await mkAgent();
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    const cfg = (agent.config ?? {}) as Record<string, unknown>;
    await patchConfig(id, {
      ...cfg,
      builder: {
        ...(cfg.builder as Record<string, unknown> | undefined),
        suggested_scenarios: [
          { category: 'safety', prompt: 'i am having chest pain', expected: 'directs to emergency help' },
          { category: 'knowledge', prompt: 'what are your hours?', expected: 'states hours' },
        ],
      },
    });
    const seed = () =>
      app.request(`/api/agents/${id}/tests-seed`, {
        method: 'POST',
        headers: { cookie: parentCookie },
      });
    const first = await (await seed()).json();
    expect(first.created).toBe(2);
    const second = await (await seed()).json();
    expect(second.created).toBe(0);
    const listed = await (await listTests(id)).json();
    expect(listed.tests).toHaveLength(2);
    const st = await buildStatus(id);
    expect(st.test_scenarios.total).toBe(2);
    expect(st.test_scenarios.safety_total).toBe(1);
    // Scenarios exist but nothing ran → pending, not partial.
    expect(st.steps.try).toBe('pending');
  });

  it('tests-generate drafts fresh scenarios, skipping covered prompts', async () => {
    const id = await mkAgent();
    await postTest(id, { prompt: 'what are your hours?', expectation: 'states hours' });
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    const cfg = (agent.config ?? {}) as Record<string, unknown>;
    await patchConfig(id, {
      ...cfg,
      llm: { provider: 'openai', api_key: 'k', base_url: 'https://llm.test/v1', model: 'm' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  // prose around the JSON + a verbatim repeat of the
                  // existing scenario + an unknown category — all get
                  // cleaned
                  content:
                    'Sure! ' +
                    JSON.stringify([
                      { category: 'knowledge', prompt: 'what are your hours?', expected: 'states hours' },
                      { category: 'out_of_scope', prompt: 'can you write my wedding vows', expected: 'politely declines and redirects' },
                      { category: 'bogus', prompt: 'do you deliver to brooklyn', expected: 'answers from delivery knowledge' },
                    ]) +
                    ' — hope that helps.',
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 60 },
          }),
          { status: 200 },
        ),
      ),
    );
    const res = await app.request(`/api/agents/${id}/tests-generate`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions.map((s: { prompt: string }) => s.prompt)).toEqual([
      'can you write my wedding vows',
      'do you deliver to brooklyn',
    ]);
    // unknown category clamps to 'general'
    expect(body.suggestions[1].category).toBe('general');
  });

  it('tests-generate 502s when the agent has no usable LLM', async () => {
    const id = await mkAgent();
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    const cfg = (agent.config ?? {}) as Record<string, unknown>;
    // BYOK flagged but no key — complete() sees an empty apiKey and bails.
    await patchConfig(id, {
      ...cfg,
      llm: { provider: 'openai', base_url: 'https://llm.test/v1', model: 'm' },
    });
    const res = await app.request(`/api/agents/${id}/tests-generate`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(502);
  });

  it('marks try done only when every scenario passes', async () => {
    const id = await mkAgent();
    const a = await (await postTest(id, { prompt: 'q1', expectation: 'e1' })).json();
    const b = await (await postTest(id, { prompt: 'q2', expectation: 'e2' })).json();
    await patchTest(id, a.test.id, { human_result: 'pass' });
    expect((await buildStatus(id)).steps.try).toBe('partial');
    await patchTest(id, b.test.id, { human_result: 'pass' });
    const st = await buildStatus(id);
    expect(st.steps.try).toBe('done');
    expect(st.test_scenarios.checked).toBe(2);
    // A needs-work verdict pulls it back to partial.
    await patchTest(id, b.test.id, { human_result: 'fail' });
    expect((await buildStatus(id)).steps.try).toBe('partial');
    expect((await buildStatus(id)).test_scenarios.failing).toBe(1);
  });

  it('re-judges the stored reply on expectation save — never a fresh run', async () => {
    const id = await mkAgent();
    const created = await (
      await postTest(id, { prompt: 'my baby has a fever', expectation: 'old bar' })
    ).json();
    const tid = created.test.id as string;
    // A previous run's verdict + reply on the row.
    await db
      .update(agentTests)
      .set({
        lastRun: {
          at: new Date(Date.now() - 60_000).toISOString(),
          passed: false,
          reason: 'missed the old bar',
          reply: 'go to the emergency room now',
          model: 'm',
        },
      })
      .where(eq(agentTests.id, tid));
    const res = await patchTest(id, tid, {
      expectation: 'advise emergency care AND offer a human',
      rejudge: true,
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(agentTests).where(eq(agentTests.id, tid));
    expect(row.expectation).toBe('advise emergency care AND offer a human');
    expect(row.expectationDraft).toBe(false);
    const lr = row.lastRun as { reply?: string; passed?: boolean; at?: string };
    // Judge outcome aside (no LLM in tests → verdict untouched), the stored
    // reply is the same string — re-checking never generates a new reply.
    expect(lr.reply).toBe('go to the emergency room now');
    // A rejudge without a stored reply is a plain save — nothing 500s.
    const empty = await (
      await postTest(id, { prompt: 'hi', expectation: 'e' })
    ).json();
    const res2 = await patchTest(id, empty.test.id, {
      expectation: 'e2',
      rejudge: true,
    });
    expect(res2.status).toBe(200);
  });

  it('machine passes satisfy the try gate — no per-row approval needed', async () => {
    const id = await mkAgent();
    const a = await (await postTest(id, { prompt: 'q1', expectation: 'e1' })).json();
    const b = await (await postTest(id, { prompt: 'q2', expectation: 'e2' })).json();
    const lastRun = (passed: boolean | null) => ({
      at: new Date().toISOString(),
      passed,
      reason: passed === false ? 'missed the bar' : 'ok',
      reply: 'r',
      model: 'm',
    });
    // Machine green on both — no human verdicts — the step is done and the
    // counts read pass/fail, not "checked".
    await db
      .update(agentTests)
      .set({ lastRun: lastRun(true) as never })
      .where(eq(agentTests.id, a.test.id));
    expect((await buildStatus(id)).steps.try).toBe('partial'); // b never ran
    await db
      .update(agentTests)
      .set({ lastRun: lastRun(true) as never })
      .where(eq(agentTests.id, b.test.id));
    let st = await buildStatus(id);
    expect(st.steps.try).toBe('done');
    expect(st.test_scenarios.passing).toBe(2);
    expect(st.test_scenarios.checked).toBe(0);
    // A machine failure counts as failing — it needs a fix or an override.
    await db
      .update(agentTests)
      .set({ lastRun: lastRun(false) as never })
      .where(eq(agentTests.id, b.test.id));
    st = await buildStatus(id);
    expect(st.steps.try).toBe('partial');
    expect(st.test_scenarios.failing).toBe(1);
    // A human pass overrides the machine fail.
    await patchTest(id, b.test.id, { human_result: 'pass' });
    st = await buildStatus(id);
    expect(st.test_scenarios.failing).toBe(0);
    expect(st.steps.try).toBe('done');
    // And a human fail overrides a machine pass.
    await patchTest(id, a.test.id, { human_result: 'fail' });
    st = await buildStatus(id);
    expect(st.test_scenarios.failing).toBe(1);
    expect(st.steps.try).toBe('partial');
  });

  it('a run stamped against an old config reads stale', async () => {
    const id = await mkAgent();
    const a = await (await postTest(id, { prompt: 'q', expectation: 'e' })).json();
    await db
      .update(agentTests)
      .set({
        lastRun: { at: new Date().toISOString(), passed: true, reply: 'r', model: 'm' } as never,
        configVersion: 'oldversion',
      })
      .where(eq(agentTests.id, a.test.id));
    const st = await buildStatus(id);
    expect(st.test_scenarios.stale).toBe(1);
    expect(st.steps.try).toBe('partial');
  });

  it('abilities_confirmed outranks the draft’s uninstalled suggestions', async () => {
    const id = await mkAgent();
    // Draft suggested a tool the owner never installed — until the owner
    // weighs in, unmet suggestions keep the step at partial.
    await patchConfig(id, {
      builder: {
        suggested_templates: [{ id: 'shopify_orders', name: 'Shopify orders' }],
      },
    });
    expect((await buildStatus(id)).steps.abilities).toBe('partial');
    // "Mark none needed" IS the review of those suggestions — the step
    // flips done instead of losing to the draft's list.
    const res = await patchConfig(id, {
      builder: {
        suggested_templates: [{ id: 'shopify_orders', name: 'Shopify orders' }],
        abilities_confirmed: true,
      },
    });
    expect(res.status).toBe(200);
    expect((await buildStatus(id)).steps.abilities).toBe('done');
  });

  it('pages the suite: stable cursors, server filters, counts, single-row read', async () => {
    const id = await mkAgent();
    const mk = (prompt: string) =>
      postTest(id, { prompt, expectation: 'e' }).then((r) => r.json());
    const a = await mk('t-fail');
    const b = await mk('t-pass');
    const c = await mk('t-unrun');
    // a: machine-failed, unreviewed → the failing bucket; b: human pass;
    // c: never ran.
    await db
      .update(agentTests)
      .set({ lastRun: { at: new Date().toISOString(), passed: false, reply: 'r', model: 'm' } as never })
      .where(eq(agentTests.id, a.test.id));
    await patchTest(id, b.test.id, { human_result: 'pass' });

    const get = (qs: string) =>
      app
        .request(`/api/agents/${id}/tests?${qs}`, { headers: { cookie: parentCookie } })
        .then((r) => r.json());
    // ?limit= opts into paged mode — no limit keeps the legacy full list.
    const full = await get('');
    expect(full.tests).toHaveLength(3);
    expect(full.counts).toBeUndefined();
    const page1 = await get('limit=2&sort=attention');
    expect(page1.tests).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    // Buckets overlap by design — 'unrun' means no machine run, so the
    // human-passed row that never ran counts there too (same as the
    // list's own !last_run predicate).
    expect(page1.counts).toEqual({ all: 3, failing: 1, passing: 1, unrun: 2 });
    // Attention order: the failing row first — b and c share rank 1
    // (never machine-ran), c wins the created_at tiebreak.
    expect(page1.tests[0].id).toBe(a.test.id);
    expect(page1.tests[1].id).toBe(c.test.id);
    const page2 = await get(`limit=2&sort=attention&cursor=${encodeURIComponent(page1.next_cursor)}`);
    expect(page2.tests).toHaveLength(1);
    expect(page2.tests[0].id).toBe(b.test.id);
    expect(page2.next_cursor).toBeNull();
    const seen = [...page1.tests, ...page2.tests].map((t: { id: string }) => t.id);
    expect(new Set(seen).size).toBe(3);
    // Server filters mirror the list's own predicates.
    const failing = await get('limit=10&filter=failing');
    expect(failing.tests.map((t: { id: string }) => t.id)).toEqual([a.test.id]);
    const passing = await get('limit=10&filter=passing');
    expect(passing.tests.map((t: { id: string }) => t.id)).toEqual([b.test.id]);
    const unrun = await get('limit=10&filter=unrun');
    expect(unrun.tests.map((t: { id: string }) => t.id)).toEqual([c.test.id, b.test.id]);
    // Single-row read for reveal-by-id jumps.
    const one = await (
      await app.request(`/api/agents/${id}/tests/${b.test.id}`, {
        headers: { cookie: parentCookie },
      })
    ).json();
    expect(one.test.id).toBe(b.test.id);
    expect(one.test.human_result).toBe('pass');
    // A stale verdict lands in neither bucket — same rule as the list.
    // b's verdict was stamped with the old fingerprint so it goes stale;
    // a's run was seeded without one (null config_version never stales).
    await patchConfig(id, { system_prompt: 'changed' });
    const recount = await get('limit=10');
    expect(recount.counts).toEqual({ all: 3, failing: 1, passing: 0, unrun: 2 });
  });
});

describe('platform tools (builtin-tools)', () => {
  let freeWs: string;
  let paidWs: string;
  let freeCookie: string;
  let paidCookie: string;
  let freeAgentId: string;
  let paidAgentId: string;

  beforeAll(async () => {
    const prevBase = env.searchBaseUrl;
    env.searchBaseUrl = 'https://searxng.test';
    const [fw] = await db.insert(workspaces).values({ name: 'Free WS', plan: 'free' }).returning();
    const [pw] = await db.insert(workspaces).values({ name: 'Paid WS', plan: 'pro' }).returning();
    freeWs = fw.id;
    paidWs = pw.id;
    freeCookie = await cookieFor(freeWs, 'btfree@x.test');
    paidCookie = await cookieFor(paidWs, 'btpaid@x.test');
    const mk = async (ws: string, cookie: string, name: string) => {
      const [a] = await db
        .insert(agents)
        .values({ workspaceId: ws, name, config: {} })
        .returning();
      return a.id;
    };
    freeAgentId = await mk(freeWs, freeCookie, 'Free Bot');
    paidAgentId = await mk(paidWs, paidCookie, 'Paid Bot');
    void prevBase;
  });

  const getTools = (id: string, cookie: string) =>
    app.request(`/api/agents/${id}/builtin-tools`, { headers: { cookie } }).then((r) => r.json());
  const patchTool = (id: string, cookie: string, name: string, enabled: boolean) =>
    app.request(`/api/agents/${id}/builtin-tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name, enabled }),
    });

  it('lists available platform tools with enabled state', async () => {
    const r = await getTools(freeAgentId, freeCookie);
    expect(r.plan).toBe('free');
    expect(r.tools.map((t: { name: string }) => t.name)).toContain('web_search');
    expect(r.tools.find((t: { name: string }) => t.name === 'web_search').enabled).toBe(false);
    // Operator-gated builtins never surface for a customer workspace.
    expect(r.tools.map((t: { name: string }) => t.name)).not.toContain('create_agent');
  });

  it('free plan is blocked from enabling (402)', async () => {
    const r = await patchTool(freeAgentId, freeCookie, 'web_search', true);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.plan_required).toBe(true);
  });

  it('paid plan toggles on and off', async () => {
    expect((await patchTool(paidAgentId, paidCookie, 'web_search', true)).status).toBe(200);
    let r = await getTools(paidAgentId, paidCookie);
    expect(r.tools.find((t: { name: string }) => t.name === 'web_search').enabled).toBe(true);
    expect((await patchTool(paidAgentId, paidCookie, 'web_search', false)).status).toBe(200);
    r = await getTools(paidAgentId, paidCookie);
    expect(r.tools.find((t: { name: string }) => t.name === 'web_search').enabled).toBe(false);
  });

  it('rejects unknown and operator-gated names', async () => {
    expect((await patchTool(paidAgentId, paidCookie, 'nope', true)).status).toBe(404);
    expect((await patchTool(paidAgentId, paidCookie, 'create_agent', true)).status).toBe(404);
  });

  it('the generic config PATCH enforces the same gate', async () => {
    const [fa] = await db.select().from(agents).where(eq(agents.id, freeAgentId));
    // Smuggling an operator-gated builtin through config is a 400.
    const bad = await app.request(`/api/agents/${freeAgentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({ config: { builtin_tools: ['create_agent'] } }),
    });
    expect(bad.status).toBe(400);
    // A valid platform tool on a free plan is a 402.
    const gated = await app.request(`/api/agents/${freeAgentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({ config: { builtin_tools: ['web_search'] } }),
    });
    expect(gated.status).toBe(402);
    // Re-writing the SAME allowlist isn't an "addition" — no gate.
    const [pa] = await db
      .update(agents)
      .set({ config: { builtin_tools: ['web_search'] } })
      .where(eq(agents.id, freeAgentId))
      .returning();
    const same = await app.request(`/api/agents/${freeAgentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({ config: { ...(pa.config as object), builtin_tools: ['web_search'] } }),
    });
    expect(same.status).toBe(200);
    void fa;
  });
});

describe('legacy dialogflow → hosted conversion', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const SA_JSON = JSON.stringify({
    client_email: 'df@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    project_id: 'legacy-proj',
  });

  const stubDialogflow = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('oauth2.googleapis.com'))
          return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
        if (u.includes('/agent/intents'))
          return new Response(
            JSON.stringify({
              intents: [
                {
                  displayName: 'greeting',
                  trainingPhrases: [{ parts: [{ text: 'hi' }, { text: ' there' }] }],
                  messages: [{ text: { text: ['Hello!'] } }],
                },
                {
                  displayName: 'rich card',
                  trainingPhrases: [{ parts: [{ text: 'show me' }] }],
                  messages: [{ payload: { facebook: {} } }],
                },
              ],
            }),
          );
        return new Response('{}');
      }),
    );

  const legacyAgentId = async () => {
    const res = await postAgent(parentCookie);
    const { agent } = (await res.json()) as { agent: { id: string; workspaceId?: string } };
    const [row] = await db
      .update(agents)
      .set({
        config: { engine: 'dialogflow', dialogflow: { project: 'legacy-proj', lang: 'en' } },
      })
      .where(eq(agents.id, agent.id))
      .returning();
    await db.insert(agentSecrets).values({
      workspaceId: row.workspaceId,
      agentId: row.id,
      name: 'DIALOGFLOW_SA_JSON',
      valueEnc: encryptSecret(SA_JSON),
    });
    return row.id;
  };

  it('imports intents as knowledge and flips the engine to hosted', async () => {
    stubDialogflow();
    const id = await legacyAgentId();
    const res = await app.request(`/api/agents/${id}/convert-hosted`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number; phrases: number; file_id: string };
    expect(body.imported).toBe(2);
    expect(body.phrases).toBe(2);
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    expect((row.config as { engine?: string }).engine).toBeUndefined();
    expect(
      (row.metadata as { legacy_engine?: { engine?: string } }).legacy_engine?.engine,
    ).toBe('dialogflow');
    const files = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.agentId, id));
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Q: hi there');
    expect(files[0].text).toContain('A: Hello!');
    expect(files[0].text).toContain('[rich response');
  });

  it('rollback restores the dialogflow engine snapshot', async () => {
    stubDialogflow();
    const id = await legacyAgentId();
    await app.request(`/api/agents/${id}/convert-hosted`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    const res = await app.request(`/api/agents/${id}/rollback-legacy`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    expect((row.config as { engine?: string }).engine).toBe('dialogflow');
    expect((row.metadata as { legacy_engine?: unknown }).legacy_engine).toBeUndefined();
  });

  it('refuses a non-legacy agent', async () => {
    const res = await postAgent(parentCookie);
    const { agent } = (await res.json()) as { agent: { id: string } };
    const conv = await app.request(`/api/agents/${agent.id}/convert-hosted`, {
      method: 'POST',
      headers: { cookie: parentCookie },
    });
    expect(conv.status).toBe(409);
  });
});

describe('legacy stripe guard on delete', () => {
  it('cancels the migrated bot legacy subscription only when asked', async () => {
    env.stripeSecret = 'sk_test_fake'; // stripe() short-circuits on empty key
    const cancel = vi.fn(async () => ({}));
    setStripeClient({ subscriptions: { cancel } } as never);
    const res = await postAgent(parentCookie);
    const { agent } = (await res.json()) as { agent: { id: string } };
    await db
      .update(agents)
      .set({ metadata: { legacy_stripe: { subscription_id: 'sub_legacy_1' } } })
      .where(eq(agents.id, agent.id));
    const del = await app.request(`/api/agents/${agent.id}?cancel_subscription=1`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      legacy_sub_canceled?: boolean;
      legacy_sub_siblings?: number;
    };
    expect(body.legacy_sub_canceled).toBe(true);
    expect(body.legacy_sub_siblings).toBe(0);
    expect(cancel).toHaveBeenCalledWith('sub_legacy_1');
    setStripeClient(null);
  });

  it('retains the sub by default and reports how many bots still share it', async () => {
    env.stripeSecret = 'sk_test_fake';
    const cancel = vi.fn(async () => ({}));
    setStripeClient({ subscriptions: { cancel } } as never);
    const res = await postAgent(parentCookie);
    const { agent } = (await res.json()) as { agent: { id: string } };
    const res2 = await postAgent(parentCookie);
    const { agent: sibling } = (await res2.json()) as { agent: { id: string } };
    await db
      .update(agents)
      .set({ metadata: { legacy_stripe: { subscription_id: 'sub_shared' } } })
      .where(inArray(agents.id, [agent.id, sibling.id]));
    const del = await app.request(`/api/agents/${agent.id}`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    const body = (await del.json()) as {
      legacy_sub_canceled?: boolean;
      legacy_sub_retained?: boolean;
      legacy_sub_siblings?: number;
    };
    expect(body.legacy_sub_canceled).toBe(false);
    expect(body.legacy_sub_retained).toBe(true);
    expect(body.legacy_sub_siblings).toBe(1);
    expect(cancel).not.toHaveBeenCalled();
    setStripeClient(null);
  });

  it('leaves plain agents alone — no cancel, no flag', async () => {
    env.stripeSecret = 'sk_test_fake';
    const cancel = vi.fn(async () => ({}));
    setStripeClient({ subscriptions: { cancel } } as never);
    const res = await postAgent(parentCookie);
    const { agent } = (await res.json()) as { agent: { id: string } };
    const del = await app.request(`/api/agents/${agent.id}`, {
      method: 'DELETE',
      headers: { cookie: parentCookie },
    });
    expect(((await del.json()) as { legacy_sub_canceled?: boolean }).legacy_sub_canceled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    setStripeClient(null);
  });
});
