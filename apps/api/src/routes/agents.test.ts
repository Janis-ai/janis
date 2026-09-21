import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sessions, users, workspaces } from '../db/schema.js';
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
    .values({ workspaceId, email, name: email, role: 'admin' })
    .returning();
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
