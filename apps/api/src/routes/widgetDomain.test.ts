import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';

// Tests swap what the domain probe sees — the health fetch and the DNS CNAME
// lookup are both stubbed per-case so no real network/DNS happens.
let cnameTargets: string[] = [];
vi.mock('node:dns/promises', () => ({
  resolveCname: async () => {
    if (!cnameTargets.length) throw new Error('ENOTFOUND');
    return cnameTargets;
  },
}));

const { channelApiRoutes } = await import('./channels.js');

let db: Db;
let app: Hono;
let cookie: string;
let webchatId: string;
let webchat2Id: string;
let metaId: string;

const req = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://t/api/channels${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const patch = (id: string, body: unknown) => req('PATCH', `/${id}`, body);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/channels', channelApiRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  const [wc] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'webchat', name: 'Bubble', credentials: {} })
    .returning();
  webchatId = wc.id;
  const [wc2] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'webchat', name: 'Bubble 2', credentials: {} })
    .returning();
  webchat2Id = wc2.id;
  const [mt] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'messenger',
      name: 'Page',
      credentials: { page_id: 'p', access_token: 't' },
    })
    .returning();
  metaId = mt.id;
  const [u] = await db
    .insert(users)
    .values({ email: 'a@a.a', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  cnameTargets = [];
});

describe('widget_domain claim', () => {
  it('claims, normalizes, and surfaces the domain on the channel', async () => {
    const res = await patch(webchatId, { widget_domain: 'Chat.Acme.COM ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel.meta.widget_domain).toBe('chat.acme.com');
  });

  it('rejects non-webchat channels and janis.ai/run.app hosts', async () => {
    expect((await patch(metaId, { widget_domain: 'chat.acme.com' })).status).toBe(400);
    expect((await patch(webchatId, { widget_domain: 'chat.janis.ai' })).status).toBe(400);
    expect((await patch(webchatId, { widget_domain: 'janis.ai' })).status).toBe(400);
    expect((await patch(webchatId, { widget_domain: 'x-1234.us-east1.run.app' })).status).toBe(400);
    expect((await patch(webchatId, { widget_domain: 'not a domain!!' })).status).toBe(400);
  });

  it('enforces uniqueness across channels but lets a channel re-save its own', async () => {
    expect((await patch(webchatId, { widget_domain: 'chat.acme.com' })).status).toBe(200);
    const clash = await patch(webchat2Id, { widget_domain: 'CHAT.acme.com' });
    expect(clash.status).toBe(409);
    // same channel, same domain — not a clash with itself
    expect((await patch(webchatId, { widget_domain: 'chat.acme.com' })).status).toBe(200);
  });

  it('clears the claim on an empty value', async () => {
    const res = await patch(webchatId, { widget_domain: '' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel.meta.widget_domain).toBeUndefined();
  });
});

describe('domain-check', () => {
  it('reports pending with no claim and for unknown channels', async () => {
    await patch(webchat2Id, { widget_domain: '' });
    const res = await req('GET', `/${webchat2Id}/domain-check`);
    expect((await res.json()).status).toBe('pending');
    // A real uuid that doesn't exist → 404; a non-uuid → 400 (id guard).
    expect(
      (await req('GET', '/00000000-0000-0000-0000-000000000000/domain-check')).status,
    ).toBe(404);
  });

  it('reports live when the domain serves our health signature', async () => {
    await patch(webchat2Id, { widget_domain: 'chat.live-test.com' });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ service: 'janis-api' }), { status: 200 }),
    );
    const res = await req('GET', `/${webchat2Id}/domain-check`);
    expect((await res.json()).status).toBe('live');
  });

  it('reports pointed when DNS aims at us but traffic does not arrive', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect failed');
    });
    cnameTargets = ['ghs.googlehosted.com.'];
    const res = await req('GET', `/${webchat2Id}/domain-check`);
    expect((await res.json()).status).toBe('pointed');
  });

  it('reports pending when the probe fails and DNS goes elsewhere', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect failed');
    });
    cnameTargets = ['cdn.someone-else.com.'];
    const res = await req('GET', `/${webchat2Id}/domain-check`);
    expect((await res.json()).status).toBe('pending');
  });
});

describe('webchat branding round-trip', () => {
  it('returns branding.radius after save — the editor reads it back', async () => {
    const res = await patch(webchatId, { branding: { radius: 20, accent: '#5b21b6' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel?: { meta?: { branding?: { radius?: number; accent?: string } } } };
    expect(body.channel?.meta?.branding?.radius).toBe(20);
    expect(body.channel?.meta?.branding?.accent).toBe('#5b21b6');
  });
});

describe('channel id guard', () => {
  it('GET /:id with a non-uuid returns 400 instead of a pg cast 500', async () => {
    const res = await req('GET', '/bubble');
    expect(res.status).toBe(400);
  });

  it('PATCH /:id with a non-uuid returns 400', async () => {
    const res = await patch('not-a-channel', { name: 'x' });
    expect(res.status).toBe(400);
  });

  it('subroutes reject a non-uuid channel id', async () => {
    const res = await req('GET', '/bubble/domain-check');
    expect(res.status).toBe(400);
  });
});
