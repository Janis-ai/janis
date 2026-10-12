import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import { agentConnections, agents, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import type { calendlyApiRoutes, calendlyPublicRoutes } from './calendly.js';

let db: Db;
let app: Hono;
let agentId: string;
let cookie: string;
// env.ts evaluates at module load — the Calendly creds must be set before
// the route module imports, same dance as gmail.test.ts.
let routes: typeof calendlyApiRoutes;
let publicRoutes: typeof calendlyPublicRoutes;

const stubFetch = (handlers: Record<string, () => Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      for (const [match, fn] of Object.entries(handlers)) {
        if (url.includes(match)) return Promise.resolve(fn());
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );

beforeAll(async () => {
  process.env.CALENDLY_CLIENT_ID = 'cal_cid';
  process.env.CALENDLY_CLIENT_SECRET = 'cal_secret';
  const mod = await import('./calendly.js');
  routes = mod.calendlyApiRoutes;
  publicRoutes = mod.calendlyPublicRoutes;

  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/calendly', routes(db))
    .route('/calendly', publicRoutes(db));

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

describe('calendly oauth', () => {
  it('connect redirects to Calendly consent with a signed state', async () => {
    const res = await app.request(`/api/calendly/connect?agent_id=${agentId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('https://auth.calendly.com/oauth/authorize');
    expect(loc).toContain('client_id=cal_cid');
    expect(loc).toContain('state=');
  });

  it('connect refuses an agent outside the workspace', async () => {
    const res = await app.request('/api/calendly/connect?agent_id=00000000-0000-0000-0000-000000000000', {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('calendly_error=');
  });

  it('callback with a forged state bounces to the error flash', async () => {
    const res = await app.request('/calendly/callback?state=forged&code=x', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('calendly_error=');
  });

  it('callback stores the connection, proves the token, installs the tools', async () => {
    const start = await app.request(`/api/calendly/connect?agent_id=${agentId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    const calls: string[] = [];
    stubFetch({
      'oauth/token': () => {
        calls.push('token');
        return new Response(
          JSON.stringify({
            access_token: 'at_1',
            refresh_token: 'rt_1',
            expires_in: 7200,
          }),
          { status: 200 },
        );
      },
      'users/me': () =>
        new Response(JSON.stringify({ resource: { name: 'Ari', uri: 'u_1' } }), {
          status: 200,
        }),
    });

    const res = await app.request(`/calendly/callback?state=${state}&code=authcode`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain(`/agents/${agentId}/integrations`);
    expect(loc).toContain('calendly_connect=Ari');

    // One connection row — the granted refresh token encrypted in creds.
    const conns = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId));
    expect(conns).toHaveLength(1);
    expect(conns[0].provider).toBe('calendly');
    expect(conns[0].label).toBe('Ari');
    // One exchange total — the callback's proof reads the 2h token it just
    // cached rather than minting a second time.
    expect(calls.filter((x) => x === 'token').length).toBe(1);

    // Tools landed stamped with the OAuth template, bound to CONN_CALENDLY_TOKEN.
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const tools = (agent.config as { tools?: { name: string; template?: string; headers?: Record<string, string> }[] }).tools ?? [];
    expect(tools.map((t) => t.name)).toContain('calendly_event_types');
    expect(tools.every((t) => t.template === 'calendly-connect')).toBe(true);
    expect(
      tools.find((t) => t.name === 'calendly_me')?.headers?.authorization,
    ).toBe('Bearer {{secrets.CONN_CALENDLY_TOKEN}}');
  });

  it('a failed token exchange redirects with the error and stores nothing', async () => {
    const start = await app.request(`/api/calendly/connect?agent_id=${agentId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    stubFetch({
      'oauth/token': () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    const res = await app.request(`/calendly/callback?state=${state}&code=bad`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('calendly_error=invalid_grant');
    const agentConns = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId));
    // only the row from the happy-path test may exist — nothing new
    expect(agentConns.length).toBeLessThanOrEqual(1);
  });
});
