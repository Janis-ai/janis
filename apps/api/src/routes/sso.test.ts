import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';

// env is a module-level snapshot — stub before importing the routes/lib.
vi.stubEnv('WORKOS_CLIENT_ID', 'client_test');
vi.stubEnv('WORKOS_API_KEY', 'sk_test_wo');
vi.stubEnv('WEB_ORIGIN', 'https://app.janis.ai');
vi.resetModules();

let app: Hono;
let db: Db;
let disableSsoIfUngated: (db: Db, workspaceId: string) => Promise<void>;

// canned WorkOS REST — 'METHOD /pathname' → {status, body}
let responses: Record<string, { status?: number; body?: unknown }>;
let calls: { method: string; path: string; body?: string }[];

const seed = async (role: 'admin' | 'member', plan = 'free') => {
  const [ws] = await db.insert(workspaces).values({ name: 'Acme', plan }).returning();
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}@x.c`,
      name: 'U',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: ws.id, role, acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) });
  return { ws, cookie: `janis_session=${token}` };
};

const ssoConfig = async (wsId: string) =>
  (await db.select({ config: workspaces.config }).from(workspaces).where(eq(workspaces.id, wsId)))[0]
    ?.config as Record<string, unknown> | null;

beforeAll(async () => {
  const { workspaceRoutes } = await import('./workspace.js');
  ({ disableSsoIfUngated } = await import('../lib/workos.js'));
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new (await import('hono')).Hono().route('/api/workspace', workspaceRoutes(db));
});

beforeEach(() => {
  responses = {};
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const hit = responses[`${method} ${url.pathname}`];
    if (!hit) {
      return new Response(JSON.stringify({ message: `unstubbed ${method} ${url.pathname}` }), {
        status: 404,
      });
    }
    if (hit.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 });
  });
});

describe('workspace SSO admin surface', () => {
  it('hides the endpoints from non-admin members', async () => {
    const { cookie } = await seed('member');
    const res = await app.request('/api/workspace/sso', { headers: { cookie } });
    expect(res.status).toBe(403);
    const setup = await app.request('/api/workspace/sso/setup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com' }),
    });
    expect(setup.status).toBe(403);
  });

  it('reports the plan gate on a free workspace', async () => {
    const { cookie } = await seed('admin', 'free');
    const res = await app.request('/api/workspace/sso', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { sso } = await res.json();
    expect(sso.configured).toBe(true);
    expect(sso.allowed).toBe(false);
    expect(sso.plan).toBe('free');
    expect(sso.organization_id).toBeNull();
  });

  it('refuses to mint a portal link on a lower plan', async () => {
    const { cookie } = await seed('admin', 'pro');
    const res = await app.request('/api/workspace/sso/setup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com' }),
    });
    expect(res.status).toBe(403);
    expect(calls.filter((c) => c.path === '/organizations')).toHaveLength(0);
  });

  it('validates the domain before touching WorkOS', async () => {
    const { cookie } = await seed('admin', 'scale');
    const res = await app.request('/api/workspace/sso/setup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain' }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('creates the WorkOS org once and returns a portal link', async () => {
    responses['POST /organizations'] = { body: { id: 'org_1' } };
    responses['POST /portal/generate_link'] = {
      body: { link: 'https://portal.workos.com/x' },
    };
    const { ws, cookie } = await seed('admin', 'scale');
    const res = await app.request('/api/workspace/sso/setup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).portal_url).toBe('https://portal.workos.com/x');

    // org created with the claimed domain, portal link for the sso intent
    const orgCall = calls.find((c) => c.path === '/organizations');
    expect(JSON.parse(orgCall!.body!).domain_data).toEqual([
      { domain: 'acme.com', state: 'pending' },
    ]);
    const portalCall = calls.find((c) => c.path === '/portal/generate_link');
    expect(JSON.parse(portalCall!.body!)).toMatchObject({
      organization: 'org_1',
      intent: 'sso',
    });

    const cfg = await ssoConfig(ws.id);
    expect(cfg?.workos).toMatchObject({ organization_id: 'org_1', domain: 'acme.com' });

    // second call reuses the org — no duplicate organization
    responses['POST /portal/generate_link'] = {
      body: { link: 'https://portal.workos.com/y' },
    };
    calls = [];
    const again = await app.request('/api/workspace/sso/setup', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com', intent: 'dsync' }),
    });
    expect(again.status).toBe(200);
    expect(calls.filter((c) => c.path === '/organizations')).toHaveLength(0);
    expect(JSON.parse(calls.find((c) => c.path === '/portal/generate_link')!.body!)).toMatchObject({
      intent: 'dsync',
    });
  });

  it('self-heals connection + directory ids from WorkOS on status reads', async () => {
    responses['GET /connections'] = {
      body: { data: [{ id: 'conn_1', status: 'active', connection_type: 'OktaSAML' }] },
    };
    responses['GET /directory_sync/directories'] = {
      body: { data: [{ id: 'dir_1', state: 'linked', type: 'okta scim' }] },
    };
    const { ws, cookie } = await seed('admin', 'scale');
    await db
      .update(workspaces)
      .set({
        config: { workos: { organization_id: 'org_1', domain: 'acme.com' } },
      })
      .where(eq(workspaces.id, ws.id));

    const res = await app.request('/api/workspace/sso', { headers: { cookie } });
    const { sso } = await res.json();
    expect(sso.connection_status).toBe('active');
    expect(sso.directory_linked).toBe(true);
    expect(sso.signin_url).toBe('https://app.janis.ai/login?sso_domain=acme.com');

    const cfg = await ssoConfig(ws.id);
    expect(cfg?.workos).toMatchObject({ connection_id: 'conn_1' });
    expect(cfg?.workos_directory_id).toBe('dir_1');
  });

  it('deletes the WorkOS connection and clears state on disable', async () => {
    responses['GET /connections'] = { body: { data: [{ id: 'conn_1', status: 'active' }] } };
    responses['DELETE /connections/conn_1'] = { status: 204 };
    const { ws, cookie } = await seed('admin', 'scale');
    await db
      .update(workspaces)
      .set({
        config: {
          workos: { organization_id: 'org_1', domain: 'acme.com', connection_id: 'conn_1' },
          workos_directory_id: 'dir_1',
        },
      })
      .where(eq(workspaces.id, ws.id));

    const res = await app.request('/api/workspace/sso/disable', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/connections/conn_1' }),
    );
    const cfg = await ssoConfig(ws.id);
    expect(cfg?.workos).toBeUndefined();
    expect(cfg?.workos_directory_id).toBeUndefined();
  });

  it('keeps SSO while gated, tears it down on downgrade', async () => {
    responses['GET /connections'] = { body: { data: [{ id: 'conn_1', status: 'active' }] } };
    responses['DELETE /connections/conn_1'] = { status: 204 };
    const { ws } = await seed('admin', 'scale');
    await db
      .update(workspaces)
      .set({
        config: {
          workos: { organization_id: 'org_1', domain: 'acme.com', connection_id: 'conn_1' },
          workos_directory_id: 'dir_1',
        },
      })
      .where(eq(workspaces.id, ws.id));

    // still gated → untouched
    await disableSsoIfUngated(db, ws.id);
    expect((await ssoConfig(ws.id))?.workos).toBeDefined();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    // scale → pro: the connection is deleted and the mapping cleared
    await db.update(workspaces).set({ plan: 'pro' }).where(eq(workspaces.id, ws.id));
    await disableSsoIfUngated(db, ws.id);
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/connections/conn_1' }),
    );
    expect((await ssoConfig(ws.id))?.workos).toBeUndefined();
  });

  it('keeps the mapping when WorkOS is unreachable (retry-able)', async () => {
    // no stubbed responses → fetch mock 404s every WorkOS call
    const { ws } = await seed('admin', 'pro');
    await db
      .update(workspaces)
      .set({ config: { workos: { organization_id: 'org_1', domain: 'acme.com' } } })
      .where(eq(workspaces.id, ws.id));
    await disableSsoIfUngated(db, ws.id);
    expect((await ssoConfig(ws.id))?.workos).toBeDefined();
  });
});
