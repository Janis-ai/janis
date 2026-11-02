import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import {
  agentConnections,
  agents,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import type { oauthApiRoutes, oauthPublicRoutes } from './oauthConnect.js';
import type { connectionCreds as connectionCredsT, connectionSecrets as connectionSecretsT } from '../lib/connections.js';

let db: Db;
let app: Hono;
let agentId: string;
let cookie: string;
// env.ts evaluates at module load — the OAuth app creds must be set before
// the route/connections modules import it, same dance as calendly.test.ts.
let routes: typeof oauthApiRoutes;
let publicRoutes: typeof oauthPublicRoutes;
let connectionCreds: typeof connectionCredsT;
let connectionSecrets: typeof connectionSecretsT;

const stubFetch = (handlers: Record<string, (init?: RequestInit) => Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      for (const [match, fn] of Object.entries(handlers)) {
        if (url.includes(match)) return Promise.resolve(fn(init));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );

beforeAll(async () => {
  process.env.JIRA_CLIENT_ID = 'jira_cid';
  process.env.JIRA_CLIENT_SECRET = 'jira_secret';
  process.env.LINEAR_CLIENT_ID = 'linear_cid';
  process.env.LINEAR_CLIENT_SECRET = 'linear_secret';
  process.env.HUBSPOT_CLIENT_ID = 'hs_cid';
  process.env.HUBSPOT_CLIENT_SECRET = 'hs_secret';
  process.env.SALESFORCE_CLIENT_ID = 'sf_cid';
  process.env.SALESFORCE_CLIENT_SECRET = 'sf_secret';
  const mod = await import('./oauthConnect.js');
  routes = mod.oauthApiRoutes;
  publicRoutes = mod.oauthPublicRoutes;
  const connMod = await import('../lib/connections.js');
  connectionCreds = connMod.connectionCreds;
  connectionSecrets = connMod.connectionSecrets;

  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/oauth', routes(db)).route('/oauth', publicRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
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

const connect = async (provider: string) => {
  const res = await app.request(`/api/oauth/${provider}/connect?agent_id=${agentId}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
};

const stateOf = (loc: string) => new URL(loc).searchParams.get('state')!;

describe('oauth connect — consent redirects', () => {
  it('jira goes to Atlassian 3LO with offline_access + api audience', async () => {
    const loc = await connect('jira');
    const url = new URL(loc);
    expect(url.origin).toBe('https://auth.atlassian.com');
    const p = url.searchParams;
    expect(p.get('audience')).toBe('api.atlassian.com');
    expect(p.get('client_id')).toBe('jira_cid');
    expect(p.get('scope')).toContain('offline_access');
    expect(p.get('scope')).toContain('write:jira-work');
    expect(p.get('redirect_uri')).toContain('/oauth/jira/callback');
  });

  it('linear asks for actor=app so issues post as the app', async () => {
    const p = new URL(await connect('linear')).searchParams;
    expect(p.get('actor')).toBe('app');
    expect(p.get('scope')).toBe('read,issues:create,comments:create');
  });

  it('salesforce hits its consent host with PKCE', async () => {
    const sf = new URL(await connect('salesforce'));
    expect(sf.host).toBe('login.salesforce.com');
    expect(sf.searchParams.get('scope')).toContain('refresh_token');
    expect(sf.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('unknown provider bounces with an error flash', async () => {
    const res = await app.request(`/api/oauth/notreal/connect?agent_id=${agentId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('oauth_error=');
  });
});

describe('oauth callbacks', () => {
  it('jira exchanges JSON, stores cloud_id, installs the jira tools', async () => {
    const state = stateOf(await connect('jira'));
    const bodies: Record<string, unknown>[] = [];
    stubFetch({
      // accessible-resources URL contains 'oauth/token' too — match first.
      'accessible-resources': () =>
        new Response(JSON.stringify([{ id: 'cloud-9', name: 'Acme' }]), { status: 200 }),
      'atlassian.com/oauth/token': (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ access_token: 'at_j', refresh_token: 'rt_j', expires_in: 3600 }),
          { status: 200 },
        );
      },
    });
    const res = await app.request(`/oauth/jira/callback?state=${state}&code=c1`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('jira_connect=Acme');

    // Token exchange spoke JSON with creds in the body (Atlassian quirk).
    expect(bodies[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'jira_cid',
      client_secret: 'jira_secret',
      code: 'c1',
    });

    const [conn] = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId));
    expect(conn.provider).toBe('jira');
    expect(conn.label).toBe('Acme');
    const creds = connectionCreds(conn);
    expect(creds.refresh_token).toBe('rt_j');
    expect(creds.cloud_id).toBe('cloud-9');

    // Tools installed from the -connect template, bound to CONN_ secrets —
    // and the URL host swapped to the 3LO cloudId path.
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const tools =
      (agent.config as { tools?: { name: string; template?: string; url: string; headers?: Record<string, string> }[] })
        .tools ?? [];
    expect(tools.map((t) => t.name)).toContain('jira_search');
    expect(tools.every((t) => t.template === 'jira-connect')).toBe(true);
    const search = tools.find((t) => t.name === 'jira_search')!;
    expect(search.headers?.authorization).toBe('Bearer {{secrets.CONN_JIRA_TOKEN}}');
    expect(search.url).toContain('api.atlassian.com/ex/jira/{{secrets.CONN_JIRA_CLOUD_ID}}');

    // The connection exposes the cloud id to {{secrets.*}} interpolation.
    const secrets = await connectionSecrets(db, agentId);
    expect(secrets.CONN_JIRA_CLOUD_ID).toBe('cloud-9');
    expect(secrets.CONN_JIRA_TOKEN).toBe('at_j');
  });

  it('linear exchanges a form, labels the workspace, installs the tools', async () => {
    const state = stateOf(await connect('linear'));
    const bodies: string[] = [];
    stubFetch({
      'linear.app/oauth/token': (init) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({ access_token: 'at_l', refresh_token: 'rt_l', expires_in: 86400 }),
          { status: 200 },
        );
      },
      'api.linear.app/graphql': () =>
        new Response(JSON.stringify({ data: { organization: { name: 'Acme WS' } } }), {
          status: 200,
        }),
    });
    const res = await app.request(`/oauth/linear/callback?state=${state}&code=c2`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('linear_connect=Acme%20WS');
    expect(bodies[0]).toContain('grant_type=authorization_code');
    expect(bodies[0]).toContain('client_id=linear_cid');

    const [conn] = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.provider, 'linear'));
    expect(conn.label).toBe('Acme WS');

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const tools =
      (agent.config as { tools?: { name: string; headers?: Record<string, string> }[] }).tools ??
      [];
    expect(
      tools.find((t) => t.name === 'linear_teams')?.headers?.authorization,
    ).toBe('Bearer {{secrets.CONN_LINEAR_TOKEN}}');
  });

  it('salesforce stores instance_url and exposes it to tools', async () => {
    const state = stateOf(await connect('salesforce'));
    stubFetch({
      'salesforce.com/services/oauth2/token': () =>
        new Response(
          JSON.stringify({
            access_token: 'at_sf',
            refresh_token: 'rt_sf',
            instance_url: 'https://acme.my.salesforce.com',
          }),
          { status: 200 },
        ),
    });
    const res = await app.request(`/oauth/salesforce/callback?state=${state}&code=c3`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('salesforce_connect=acme.my.salesforce.com');

    const [conn] = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.provider, 'salesforce'));
    expect(connectionCreds(conn).instance_url).toBe('https://acme.my.salesforce.com');

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const tools = (agent.config as { tools?: { name: string; url: string }[] }).tools ?? [];
    expect(tools.find((t) => t.name === 'salesforce_query')?.url).toContain(
      '{{secrets.CONN_SALESFORCE_INSTANCE_URL}}',
    );

    const secrets = await connectionSecrets(db, agentId);
    expect(secrets.CONN_SALESFORCE_INSTANCE_URL).toBe('https://acme.my.salesforce.com');
  });

  it('a forged state bounces with oauth_error and stores nothing', async () => {
    const res = await app.request('/oauth/jira/callback?state=forged&code=x', {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('oauth_error=');
    const conns = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.provider, 'jira'));
    expect(conns).toHaveLength(1); // only the happy-path row above
  });

  it('a failed token exchange stores nothing', async () => {
    const state = stateOf(await connect('jira'));
    stubFetch({
      'atlassian.com/oauth/token': () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    const res = await app.request(`/oauth/jira/callback?state=${state}&code=bad`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('jira_error=invalid_grant');
  });
});
