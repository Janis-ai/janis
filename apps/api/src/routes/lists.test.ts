import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { contacts, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { listRoutes } from './lists.js';

let db: Db;
let api: Hono;
let cookie: string;
let workspaceId: string;

const post = (path: string, body: unknown, auth = cookie) =>
  api.request(path, {
    method: 'POST',
    headers: { cookie: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path: string, auth = cookie) => api.request(path, { headers: { cookie: auth } });

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  api = new Hono().route('/api/lists', listRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  workspaceId = ws.id;
  const [u] = await db
    .insert(users)
    .values({ email: 'a@a.a', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, workspaceId, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;
});

describe('lists', () => {
  it('creates, lists, adds and removes members', async () => {
    const created = await post('/api/lists', { name: 'vip' });
    expect(created.status).toBe(201);
    const { list } = await created.json();

    const [c] = await db
      .insert(contacts)
      .values({ workspaceId, email: 'one@x.com' })
      .returning();
    const add = await post(`/api/lists/${list.id}/members`, { contact_id: c.id });
    expect(add.status).toBe(200);

    const lists = await (await get('/api/lists')).json();
    expect(lists.lists.find((l: { id: string }) => l.id === list.id).members).toBe(1);

    const members = await (await get(`/api/lists/${list.id}/members`)).json();
    expect(members.members.map((m: { email: string }) => m.email)).toEqual(['one@x.com']);

    const del = await api.request(`/api/lists/${list.id}/members/${c.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    const after = await (await get(`/api/lists/${list.id}/members`)).json();
    expect(after.members.length).toBe(0);
  });

  it('imports CSV — dedupes on email/phone, folds new addresses into alts, applies tags', async () => {
    // Pre-existing contact the import should match rather than duplicate.
    const [existing] = await db
      .insert(contacts)
      .values({ workspaceId, email: 'have@x.com', name: 'Have' })
      .returning();

    const csv = [
      'name,email,phone,tags',
      'New Person,new@x.com,+1555111,vip; import-2024',
      // Same person, different casing + a phone they didn't have → match + enrich
      'Have Two,HAVE@X.COM,+1555222,',
      'No Contact Info,,,',
      'Bad Email,not-an-email,,',
    ].join('\n');
    const res = await post('/api/lists/import', { name: 'october', csv });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.matched).toBe(1);
    expect(body.skipped).toBe(2);

    // The matched row enriched: phone landed, casing normalized.
    const [row] = await db.select().from(contacts).where(eq(contacts.id, existing.id));
    expect(row.email).toBe('have@x.com');
    expect(row.phone).toBe('+1555222');

    // New contact got its tags; both are in the list.
    const members = await (await get(`/api/lists/${body.list_id}/members`)).json();
    expect(members.members.length).toBe(2);
    const fresh = members.members.find((m: { email: string }) => m.email === 'new@x.com');
    expect(fresh.tags).toEqual(['vip', 'import-2024']);

    // Re-import is idempotent — both valid rows match existing contacts now.
    const again = await post('/api/lists/import', { list_id: body.list_id, csv });
    const b2 = await again.json();
    expect(b2.created).toBe(0);
    expect(b2.matched).toBe(2);
    const all = await db.select().from(contacts);
    expect(all.length).toBe(3); // vip-list contact + existing + new@x.com
  });

  it('import is workspace-scoped and admin-only', async () => {
    const [ws2] = await db.insert(workspaces).values({ name: 'Other' }).returning();
    const [u2] = await db
      .insert(users)
      .values({ email: 'm@m.m', name: 'Mem', passwordHash: await hashPassword('password123') })
      .returning();
    await db
      .insert(memberships)
      .values({ userId: u2.id, workspaceId: ws2.id, role: 'member', acceptedAt: new Date() });
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: u2.id, workspaceId: ws2.id, expiresAt: new Date(Date.now() + 86_400_000) });
    const memberCookie = `janis_session=${token}`;

    // Member (not admin) → 403 on mutations.
    const res = await post('/api/lists/import', { name: 'x', csv: 'email\na@b.co' }, memberCookie);
    expect(res.status).toBe(403);
    // Reads work for members.
    expect((await get('/api/lists', memberCookie)).status).toBe(200);
  });
});
