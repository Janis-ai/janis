import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { errorReports, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { env } from '../env.js';
import { errorReportIngest, errorReportRoutes } from './errorReports.js';

let db: Db;
let api: Hono;
let cookie: string;
let workspaceId: string;
let otherCookie: string;
let prevOperator: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  api = new Hono()
    .route('/api/error-report', errorReportIngest(db))
    .route('/api/error-reports', errorReportRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  workspaceId = ws.id;
  prevOperator = env.operatorWorkspaceId;
  env.operatorWorkspaceId = workspaceId;

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

  // A client workspace's admin — must get 403 on every read.
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

afterAll(() => {
  env.operatorWorkspaceId = prevOperator;
});

const ingest = (body: unknown, auth?: string) =>
  api.request('/api/error-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) },
    body: JSON.stringify(body),
  });

describe('error reports', () => {
  it('accepts an unauthenticated report and lists it for the operator', async () => {
    const res = await ingest({ message: 'login page broke', url: 'https://app.janis.ai/login' });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [row] = await db.select().from(errorReports).where(eq(errorReports.id, id));
    expect(row.workspaceId).toBeNull();

    // The operator workspace sees anonymous reports alongside its own.
    const list = await api.request('/api/error-reports', { headers: { cookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).reports.find((r: { id: string }) => r.id === id).message).toBe(
      'login page broke',
    );
  });

  it('attaches the session workspace/user and serves the full packet on detail', async () => {
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

    const [row] = await db.select().from(errorReports).where(eq(errorReports.id, id));
    expect(row.workspaceId).toBe(workspaceId);

    const detail = await api.request(`/api/error-reports/${id}`, { headers: { cookie } });
    const { report } = await detail.json();
    expect(report.payload.console_tail).toEqual(['error: kaboom']);
    expect(report.payload.failed_requests[0].status).toBe(500);
  });

  it('denies every read to non-operator workspaces', async () => {
    expect((await api.request('/api/error-reports', { headers: { cookie: otherCookie } })).status).toBe(403);
    expect((await api.request('/api/error-reports/export', { headers: { cookie: otherCookie } })).status).toBe(403);
    const [any] = await db.select({ id: errorReports.id }).from(errorReports).limit(1);
    expect(
      (await api.request(`/api/error-reports/${any.id}`, { headers: { cookie: otherCookie } })).status,
    ).toBe(403);
    expect((await api.request('/api/error-reports')).status).toBe(401);
  });

  it('export returns reports since the last download and advances the cursor', async () => {
    const first = await api.request('/api/error-reports/export', { headers: { cookie } });
    const firstBundle = await first.json();
    expect(first.status).toBe(200);
    expect(firstBundle.count).toBeGreaterThanOrEqual(2);
    expect(firstBundle.reports.map((r: { message: string }) => r.message)).toContain(
      'login page broke',
    );
    expect(first.headers.get('content-disposition')).toContain('attachment');

    // Second export: nothing new — the cursor advanced past them.
    const second = await api.request('/api/error-reports/export', { headers: { cookie } });
    expect((await second.json()).count).toBe(0);

    await ingest({ message: 'post-export crash' });
    const third = await api.request('/api/error-reports/export', { headers: { cookie } });
    const thirdBundle = await third.json();
    expect(thirdBundle.count).toBe(1);
    expect(thirdBundle.reports[0].message).toBe('post-export crash');

    // ?all=1 dumps everything regardless of the cursor.
    const full = await api.request('/api/error-reports/export?all=1', { headers: { cookie } });
    expect((await full.json()).count).toBeGreaterThanOrEqual(3);
  });

  it('alerting stamps the workspace watermark and respects the cooldown', async () => {
    // Alerting is fire-and-forget — give earlier ingests a tick to stamp.
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await db.select({ config: workspaces.config }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const stamped = (after.config as Record<string, unknown>).error_alert_at as string;
    expect(stamped).toBeTruthy();

    // A new report inside the cooldown window must not re-stamp.
    await ingest({ message: 'within cooldown' });
    await new Promise((r) => setTimeout(r, 300));
    const [later] = await db.select({ config: workspaces.config }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect((later.config as Record<string, unknown>).error_alert_at).toBe(stamped);
  });

  it('rejects oversized and bodiless reports', async () => {
    expect((await ingest({ message: '' })).status).toBe(400);
    expect((await ingest({ message: 'x'.repeat(3_000) })).status).toBe(400);
    expect((await ingest({ message: 'ok', payload: { dom: 'x'.repeat(300_000) } })).status).toBe(400);
  });
});
