import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agentConnections, agents, conversations, memberships, messages, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { env } from '../env.js';
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
    // not in the map → untouched
    expect(byName('shopify_create_draft_order').approval).toBe(true);
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
