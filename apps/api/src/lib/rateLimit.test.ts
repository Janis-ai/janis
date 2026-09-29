import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { dbRateLimit, rateLimit } from './rateLimit.js';

let db: Db;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
});

function testApp(limit: MiddlewareHandlerReturn, path = '/t/:token/hit') {
  const app = new Hono();
  app.use(path, limit);
  app.post(path, (c) => c.json({ ok: true }));
  app.get(path, (c) => c.json({ ok: true }));
  return app;
}
type MiddlewareHandlerReturn = ReturnType<typeof dbRateLimit>;

describe('dbRateLimit', () => {
  it('allows under the cap, 429s over it with Retry-After', async () => {
    const app = testApp(
      dbRateLimit(db, {
        scope: 't-under',
        windowMs: 60_000,
        max: 3,
        methods: ['POST'],
        key: (c) => c.req.param('token'),
      }),
    );
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/t/chan1/hit', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const res = await app.request('/t/chan1/hit', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('isolates buckets per key and per scope', async () => {
    const app = testApp(
      dbRateLimit(db, {
        scope: 't-iso',
        windowMs: 60_000,
        max: 1,
        methods: ['POST'],
        key: (c) => c.req.param('token'),
      }),
    );
    expect((await app.request('/t/a/hit', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/t/b/hit', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/t/a/hit', { method: 'POST' })).status).toBe(429);
  });

  it('does not count requests outside the method filter', async () => {
    const app = testApp(
      dbRateLimit(db, {
        scope: 't-methods',
        windowMs: 60_000,
        max: 1,
        methods: ['POST'],
        key: (c) => c.req.param('token'),
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/t/m/hit')).status).toBe(200);
    }
    expect((await app.request('/t/m/hit', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/t/m/hit', { method: 'POST' })).status).toBe(429);
  });

  it('resets after the window expires', async () => {
    // Pre-seed an exhausted bucket whose window already passed — the upsert
    // must reset the count rather than 429.
    await db.execute(sql`
      insert into rate_limits (key, count, reset_at)
      values ('t-expired:tok', 99, now() - interval '1 second')
    `);
    const app = testApp(
      dbRateLimit(db, {
        scope: 't-expired',
        windowMs: 60_000,
        max: 1,
        methods: ['POST'],
        key: (c) => c.req.param('token'),
      }),
    );
    expect((await app.request('/t/tok/hit', { method: 'POST' })).status).toBe(200);
  });

  it('fails open when the database is unreachable', async () => {
    const broken = { execute: () => Promise.reject(new Error('db down')) } as unknown as Db;
    const app = testApp(
      dbRateLimit(broken, { scope: 't-broken', windowMs: 60_000, max: 1, methods: ['POST'] }),
    );
    expect((await app.request('/t/x/hit', { method: 'POST' })).status).toBe(200);
  });
});

describe('rateLimit (in-memory)', () => {
  it('still caps per instance', async () => {
    const app = testApp(rateLimit({ windowMs: 60_000, max: 1, methods: ['POST'] }), '/r/:token');
    expect((await app.request('/r/x', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/r/x', { method: 'POST' })).status).toBe(429);
  });
});
