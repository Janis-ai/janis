import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channelBindings,
  channels,
  conversations,
  memberships,
  metaConnections,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';

const SECRET = 'meta-test-secret';
const META_USER = 'meta-user-1';

let db: Db;
let app: Hono;
let cookie: string;
let agentId: string;

const b64url = (b: Buffer | string) =>
  (typeof b === 'string' ? Buffer.from(b) : b).toString('base64url');

const signedRequest = (userId: string, secret = SECRET) => {
  const payload = b64url(JSON.stringify({ user_id: userId }));
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${sig}.${payload}`;
};

const postSigned = (path: string, sr: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_request: sr }).toString(),
  });

beforeAll(async () => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_APP_ID = 'meta-app-test';
  process.env.API_ORIGIN = 'https://api.test';
  const { metaPublicRoutes, metaApiRoutes } = await import('./meta.js');
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/meta', metaPublicRoutes(db))
    .route('/api/meta', metaApiRoutes(db));

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
  const { token, id: sid } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id: sid, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  cookie = `${SESSION_COOKIE}=${token}`;
  await db.insert(metaConnections).values({ workspaceId: ws.id, userToken: 'tok', metaUserId: META_USER });
  const [ig] = await db
    .insert(channels)
    .values({
      workspaceId: ws.id,
      agentId: agent.id,
      kind: 'instagram',
      name: 'IG',
      credentials: { page_id: 'ig1', access_token: 't' },
    })
    .returning();
  await db.insert(channels).values({
    workspaceId: ws.id,
    agentId: agent.id,
    kind: 'webchat',
    name: 'Web',
    credentials: {},
  });
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'ig:u1' })
    .returning();
  await db
    .insert(channelBindings)
    .values({ channelId: ig.id, conversationId: conv.id, platformUserId: 'u1' });
});

describe('meta platform callbacks', () => {
  it('rejects an invalidly signed request', async () => {
    expect((await postSigned('/meta/data-deletion', 'bogus.sig')).status).toBe(400);
    expect((await postSigned('/meta/data-deletion', signedRequest(META_USER, 'wrong'))).status).toBe(
      400,
    );
  });

  it('deletes the connection and meta channels, returns a confirmation', async () => {
    const res = await postSigned('/meta/data-deletion', signedRequest(META_USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.confirmation_code).toMatch(/^jd_/);
    expect(body.url).toContain(body.confirmation_code);

    expect(await db.select().from(metaConnections)).toHaveLength(0);
    const remaining = await db.select().from(channels);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].kind).toBe('webchat');
    expect(await db.select().from(channelBindings)).toHaveLength(0);
    // transcripts belong to the workspace, not the Meta user — they stay
    expect(await db.select().from(conversations)).toHaveLength(1);

    const status = await app.request(`/meta/data-deletion/status?code=${body.confirmation_code}`);
    expect((await status.json()).status).toBe('completed');
  });

  it('status reports unknown codes as not_found', async () => {
    const res = await app.request('/meta/data-deletion/status?code=jd_nope');
    expect((await res.json()).status).toBe('not_found');
  });

  it('deauthorize clears the connection for a known user', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'W2' }).returning();
    await db.insert(metaConnections).values({ workspaceId: ws.id, userToken: 't2', metaUserId: 'mu2' });
    const res = await postSigned('/meta/deauthorize', signedRequest('mu2'));
    expect(res.status).toBe(200);
    expect(await db.select().from(metaConnections)).toHaveLength(0);
  });
});

describe('meta connect', () => {
  it('carries the target agent through the OAuth round-trip', async () => {
    const res = await app.request(`/api/meta/connect?agent=${agentId}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get('location')!);
    expect(consent.host).toBe('www.facebook.com');
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain(`janis_meta_agent=${agentId}`);
    expect(cookies).toContain('janis_meta_state=');
  });

  it('rejects an agent from outside the workspace', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'Other' }).returning();
    const { hash, preview } = generateApiKey();
    const [other] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'X', apiKeyHash: hash, apiKeyPreview: preview })
      .returning();
    const res = await app.request(`/api/meta/connect?agent=${other.id}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('works without an agent query (lands on the agents list)', async () => {
    const res = await app.request('/api/meta/connect', {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('janis_meta_agent=');
  });
});
