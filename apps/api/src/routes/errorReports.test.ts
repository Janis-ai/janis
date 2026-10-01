import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { errorReports, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { errorReportIngest, errorReportRoutes } from './errorReports.js';

let db: Db;
let api: Hono;
let cookie: string;
let workspaceId: string;
let otherCookie: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  api = new Hono()
    .route('/api/error-report', errorReportIngest(db))
    .route('/api/error-reports', errorReportRoutes(db));

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

  // A second workspace's admin — must not see W's reports.
  const [ws2] = await db.insert(workspaces).values({ name: 'Other' }).returning();
  const [u2] = await db
    .insert(users)
    .values({ email: 'b@b.b', name: 'Other', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u2.id, workspaceId: ws2.id, role: 'admin', acceptedAt: new Date() });
  const s2 = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id: s2.id, userId: u2.id, workspaceId: ws2.id, expiresAt: new Date(Date.now() + 86_400_000) });
  otherCookie = `janis_session=${s2.token}`;
});

const ingest = (body: unknown, auth?: string) =>
  api.request('/api/error-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) },
    body: JSON.stringify(body),
  });

describe('error reports', () => {
  it('accepts an unauthenticated report and scopes it to no workspace', async () => {
    const res = await ingest({ message: 'login page broke', url: 'https://app.janis.ai/login' });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [row] = await db.select().from(errorReports).where(eq(errorReports.id, id));
    expect(row.workspaceId).toBeNull();
    // Anonymous reports are invisible to ordinary workspaces.
    const list = await api.request('/api/error-reports', { headers: { cookie } });
    expect((await list.json()).reports.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  it('attaches the session workspace/user and lists it for that workspace admin', async () => {
    const res = await ingest(
      {
        message: 'render blew up',
        stack: 'Error: render blew up\n    at App (app.tsx:1)',
        url: 'https://app.janis.ai/conversations',
        payload: {
          route: '/conversations',
          ua: 'test-agent',
          console_tail: ['error: kaboom'],
          failed_requests: [{ url: '/api/conversations', status: 500 }],
          settings: { 'local:theme': 'dark' },
        },
      },
      cookie,
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const list = await api.request('/api/error-reports', { headers: { cookie } });
    const listed = (await list.json()).reports.find((r: { id: string }) => r.id === id);
    expect(listed.message).toBe('render blew up');
    expect(listed.route).toBe('/conversations');

    // Full packet on detail — DOM/screenshot/settings survive the round-trip.
    const detail = await api.request(`/api/error-reports/${id}`, { headers: { cookie } });
    const { report } = await detail.json();
    expect(report.payload.console_tail).toEqual(['error: kaboom']);
    expect(report.payload.failed_requests[0].status).toBe(500);
    expect(report.workspaceId).toBe(workspaceId);

    // Another workspace's admin can't see or fetch it.
    const other = await api.request('/api/error-reports', { headers: { cookie: otherCookie } });
    expect((await other.json()).reports).toHaveLength(0);
    const denied = await api.request(`/api/error-reports/${id}`, { headers: { cookie: otherCookie } });
    expect(denied.status).toBe(404);
  });

  it('rejects oversized and bodiless reports', async () => {
    expect((await ingest({ message: '' })).status).toBe(400);
    expect((await ingest({ message: 'x'.repeat(3_000) })).status).toBe(400);
    expect((await ingest({ message: 'ok', payload: { dom: 'x'.repeat(300_000) } })).status).toBe(400);
  });

  it('requires admin auth on reads', async () => {
    expect((await api.request('/api/error-reports')).status).toBe(401);
  });
});
