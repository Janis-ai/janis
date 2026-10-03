import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { eq } from 'drizzle-orm';

// env.ts reads process.env at import time — resend key must exist before
// the route module loads so resendDomains can call the API.
process.env.RESEND_API_KEY = 're_test_key';
process.env.EMAIL_INBOUND_DOMAIN = 'inbound.janis.ai';
process.env.CLOUDFLARE_OAUTH_CLIENT_ID = 'cf_client';
process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = 'cf_secret';

const { channelApiRoutes, channelWebhookRoutes } = await import('./channels.js');

let db: Db;
let app: Hono;
let cookie: string;
let channelId: string;

const j = (res: Response) => res.json() as Promise<Record<string, unknown>>;

const resendDomain = {
  id: 'dom_1',
  name: 'mail.acme.com',
  status: 'pending',
  records: [{ type: 'TXT', name: 'resend._domainkey.mail', value: 'p=abc' }],
};

function stubResend(verifyStatus = 'verified') {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/domains') && init?.method === 'POST')
      return new Response(JSON.stringify(resendDomain), { status: 200 });
    if (url.endsWith('/verify'))
      return new Response('{}', { status: 200 });
    if (/\/domains\/dom_1$/.test(url) && init?.method === 'DELETE')
      return new Response('{}', { status: 200 });
    if (/\/domains\/dom_1$/.test(url))
      return new Response(JSON.stringify({ ...resendDomain, status: verifyStatus }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/channels', channelApiRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  const [ch] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'email', name: 'Mail', credentials: {} })
    .returning();
  channelId = ch.id;
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

afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://t/api/channels${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const patch = (body: unknown) =>
  app.fetch(
    new Request(`http://t/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('custom email domain', () => {
  it('registers a domain and returns DNS records', async () => {
    stubResend();
    const res = await post(`/${channelId}/email-domain`, { domain: 'https://Mail.Acme.com/x' });
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.email_domain).toBe('mail.acme.com');
    expect(body.status).toBe('pending');
    expect((body.records as unknown[]).length).toBe(1);
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    expect((ch.credentials as { email_domain_id?: string }).email_domain_id).toBe('dom_1');
  });

  it('rejects from_address on an unverified domain, allows after verify', async () => {
    stubResend();
    expect(
      (await patch({ from_address: 'support@mail.acme.com' })).status,
    ).toBe(400);
    const v = await post(`/${channelId}/email-domain/verify`);
    expect((await j(v)).status).toBe('verified');
    expect((await patch({ from_address: 'support@mail.acme.com' })).status).toBe(200);
  });

  it('allows addresses on the shared inbound domain, rejects strangers', async () => {
    expect((await patch({ from_address: 'support@inbound.janis.ai' })).status).toBe(200);
    expect((await patch({ from_address: 'support@other.com' })).status).toBe(400);
  });

  it('adopts an already-registered domain instead of erroring', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/domains') && init?.method === 'POST')
        return new Response(JSON.stringify({ message: 'domain already exists' }), { status: 409 });
      if (url.endsWith('/domains'))
        return new Response(JSON.stringify({ data: [{ id: 'dom_9', name: 'mail.acme.com' }] }), { status: 200 });
      if (/\/domains\/dom_9$/.test(url))
        return new Response(JSON.stringify({ ...resendDomain, id: 'dom_9' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const res = await post(`/${channelId}/email-domain`, { domain: 'mail.acme.com' });
    expect(res.status).toBe(200);
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    expect((ch.credentials as { email_domain_id?: string }).email_domain_id).toBe('dom_9');
  });

  it('cf-setup creates missing Cloudflare records then verifies', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.cloudflare.com')) {
        if (/\/zones\?name=mail\.acme\.com/.test(url)) return new Response('{"result":[]}', { status: 200 });
        if (/\/zones\?name=acme\.com/.test(url))
          return new Response('{"result":[{"id":"z1","name":"acme.com"}]}', { status: 200 });
        if (url.includes('/dns_records') && init?.method === 'POST')
          return new Response('{"result":{}}', { status: 200 });
        if (url.includes('/dns_records')) return new Response('{"result":[]}', { status: 200 });
      }
      if (url.endsWith('/verify')) return new Response('{}', { status: 200 });
      if (/\/domains\/dom_9$/.test(url))
        return new Response(JSON.stringify({ ...resendDomain, id: 'dom_9', status: 'verified' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const res = await post(`/${channelId}/email-domain/cf-setup`, { api_token: 'x'.repeat(40) });
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.zone).toBe('acme.com');
    expect(body.status).toBe('verified');
    // second run skips existing records
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/zones\?name=mail\.acme\.com/.test(url)) return new Response('{"result":[]}', { status: 200 });
      if (/\/zones\?name=acme\.com/.test(url))
        return new Response('{"result":[{"id":"z1","name":"acme.com"}]}', { status: 200 });
      if (url.includes('/dns_records'))
        return new Response('{"result":[{"id":"r1"}]}', { status: 200 });
      if (url.endsWith('/verify')) return new Response('{}', { status: 200 });
      if (/\/domains\/dom_9$/.test(url))
        return new Response(JSON.stringify({ ...resendDomain, id: 'dom_9', status: 'verified' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const res2 = await post(`/${channelId}/email-domain/cf-setup`, { api_token: 'x'.repeat(40) });
    expect((await j(res2)).skipped).toBe(1);
  });

  it('oauth callback exchanges the code, stores the refresh token, pushes records', async () => {
    // consent URL carries a signed state binding the flow to the channel
    const conn = await post(`/${channelId}/email-domain/cf-connect`);
    const { url } = (await j(conn)) as { url: string };
    expect(url).toContain('dash.cloudflare.com/oauth2/authorize');
    expect(url).toContain('client_id=cf_client');
    const state = new URL(url).searchParams.get('state')!;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes('oauth2/token'))
        return new Response('{"access_token":"cf_at","refresh_token":"cf_rt"}', { status: 200 });
      if (/\/zones\?name=mail\.acme\.com/.test(u)) return new Response('{"result":[]}', { status: 200 });
      if (/\/zones\?name=acme\.com/.test(u))
        return new Response('{"result":[{"id":"z1","name":"acme.com"}]}', { status: 200 });
      if (u.includes('/dns_records') && init?.method === 'POST')
        return new Response('{"result":{}}', { status: 200 });
      if (u.includes('/dns_records')) return new Response('{"result":[]}', { status: 200 });
      if (u.endsWith('/verify')) return new Response('{}', { status: 200 });
      if (/\/domains\/dom_9$/.test(u))
        return new Response(JSON.stringify({ ...resendDomain, id: 'dom_9', status: 'verified' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const hooks = new Hono().route('/channels', channelWebhookRoutes(db));
    const cb = await hooks.fetch(
      new Request(`http://t/channels/email-domain/cf-callback?code=CODE&state=${encodeURIComponent(state)}`),
    );
    expect(cb.status).toBe(302);
    // OAuth returns land on the channel's own page, not the index
    expect(cb.headers.get('location')).toContain(`/channels/${channelId}?`);
    expect(cb.headers.get('location')).toContain('cf_connect=');
    expect(decodeURIComponent(cb.headers.get('location')!)).toContain('1 record created');
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    expect((ch.credentials as { cf_refresh_token?: string }).cf_refresh_token).toBe('cf_rt');

    // forged or expired state is rejected
    const bad = await hooks.fetch(
      new Request(`http://t/channels/email-domain/cf-callback?code=CODE&state=cf.bogus.sig`),
    );
    expect(bad.headers.get('location')).toContain('cf_error');

    // cf-setup without a token uses the stored refresh token
    const res = await post(`/${channelId}/email-domain/cf-setup`, {});
    expect(res.status).toBe(200);
  });

  it('dns-setup picks the best path for the domain', async () => {
    // no DC key configured + acme.com isn't Cloudflare-hosted → manual
    const res = await post(`/${channelId}/email-domain/dns-setup`);
    expect(res.status).toBe(200);
    expect((await j(res)).mode).toBe('manual');
  });

  it('sweep refreshes a stale pending domain to verified, then allows from_address', async () => {
    stubResend('verified');
    const src = (await db.select().from(channels).where(eq(channels.id, channelId)))[0];
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: src.workspaceId,
        agentId: src.agentId,
        kind: 'email',
        name: 'Stale',
        credentials: {
          email_domain: 'mail.acme.com',
          email_domain_id: 'dom_1',
          email_domain_status: 'pending',
        },
      })
      .returning();
    const { sweepEmailDomainStatus } = await import('../lib/resendDomains.js');
    expect(await sweepEmailDomainStatus(db)).toBe(1);
    const [after] = await db.select().from(channels).where(eq(channels.id, ch.id));
    const creds = after.credentials as { email_domain_status?: string };
    expect(creds.email_domain_status).toBe('verified');
  });

  it('sweep marks a Resend-deleted domain as failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"message":"Domain not found"}', { status: 404 }));
    const src = (await db.select().from(channels).where(eq(channels.id, channelId)))[0];
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: src.workspaceId,
        agentId: src.agentId,
        kind: 'email',
        name: 'Gone',
        credentials: {
          email_domain: 'gone.acme.com',
          email_domain_id: 'dom_gone',
          email_domain_status: 'pending',
        },
      })
      .returning();
    const { sweepEmailDomainStatus } = await import('../lib/resendDomains.js');
    await sweepEmailDomainStatus(db);
    const [after] = await db.select().from(channels).where(eq(channels.id, ch.id));
    expect((after.credentials as { email_domain_status?: string }).email_domain_status).toBe('failed');
  });

  it('sweep skips domains checked within the throttle window', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{}', { status: 200 });
    });
    const src = (await db.select().from(channels).where(eq(channels.id, channelId)))[0];
    await db.insert(channels).values({
      workspaceId: src.workspaceId,
      agentId: src.agentId,
      kind: 'email',
      name: 'Recent',
      credentials: {
        email_domain: 'recent.acme.com',
        email_domain_id: 'dom_recent',
        email_domain_status: 'pending',
        email_domain_checked_at: new Date().toISOString(),
      },
    });
    const { sweepEmailDomainStatus } = await import('../lib/resendDomains.js');
    await sweepEmailDomainStatus(db);
    expect(calls).toBe(0);
  });

  it('delete clears domain creds and a dependent from_address', async () => {
    await patch({ from_address: 'support@mail.acme.com' });
    const res = await app.fetch(
      new Request(`http://t/api/channels/${channelId}/email-domain`, {
        method: 'DELETE',
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    const creds = ch.credentials as Record<string, unknown>;
    expect(creds.email_domain).toBeUndefined();
    expect(creds.from_address).toBeUndefined();
  });
});
