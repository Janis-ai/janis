import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  helpArticles,
  helpSearchLog,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { articleRoutes, helpPublicRoutes } from './helpCenter.js';
import { eq } from 'drizzle-orm';

let app: Hono;
let db: Db;
let cookie: string;
let wsId: string;
let agentId: string;

const j = (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/help', helpPublicRoutes(db))
    .route('/api/articles', articleRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'HC', plan: 'pro' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({ email: 'h@b.c', name: 'H', passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: admin.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;

  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: 'h', apiKeyPreview: 'p' })
    .returning();
  agentId = agent.id;

  const now = new Date();
  await db.insert(helpArticles).values([
    {
      workspaceId: ws.id,
      agentId,
      title: 'Refund policy',
      slug: 'refund-policy',
      category: 'Billing',
      body: 'You can request a refund within 30 days of purchase.',
      status: 'published',
      publishedAt: now,
    },
    {
      workspaceId: ws.id,
      agentId,
      title: 'Shipping times',
      slug: 'shipping-times',
      category: 'Orders',
      body: 'Standard shipping takes 5-7 days. Refunds for late shipments are reviewed case by case.',
      status: 'published',
      publishedAt: now,
    },
    {
      workspaceId: ws.id,
      agentId,
      title: 'Internal runbook',
      slug: 'runbook',
      category: 'Ops',
      body: 'Never published.',
      status: 'draft',
    },
  ]);
});

describe('help center public search', () => {
  it('returns published articles only, grouped by category', async () => {
    const res = await app.fetch(new Request(`http://t/api/help/${agentId}`));
    const body = await j(res);
    expect(res.status).toBe(200);
    const cats = body.categories as { name: string; articles: { title: string }[] }[];
    const titles = cats.flatMap((g) => g.articles.map((a) => a.title));
    expect(titles).toContain('Refund policy');
    expect(titles).not.toContain('Internal runbook');
  });

  it('ranks lexical matches first and logs the search', async () => {
    // 'refund' appears in the title of #1 and only the body of #2 — the
    // title-weighted tsvector match should rank first.
    const res = await app.fetch(new Request(`http://t/api/help/${agentId}?q=refund`));
    const body = await j(res);
    expect(res.status).toBe(200);
    const cats = body.categories as { articles: { title: string }[] }[];
    const titles = cats.flatMap((g) => g.articles.map((a) => a.title));
    expect(titles[0]).toBe('Refund policy');

    const [log] = await db
      .select()
      .from(helpSearchLog)
      .where(eq(helpSearchLog.agentId, agentId));
    expect(log.query).toBe('refund');
    expect(log.results).toBe(titles.length);
    expect(log.workspaceId).toBe(wsId);
  });

  it('falls back to verbatim matching for lexeme-less queries', async () => {
    // "5-7" produces no English lexemes — ILIKE fallback must still find it.
    const res = await app.fetch(new Request(`http://t/api/help/${agentId}?q=5-7`));
    const body = await j(res);
    const cats = body.categories as { articles: { title: string }[] }[];
    expect(cats.flatMap((g) => g.articles.map((a) => a.title))).toContain('Shipping times');
  });
});

describe('view counts + insights', () => {
  it('bumps view_count on public article fetch', async () => {
    const before = await db
      .select({ v: helpArticles.viewCount })
      .from(helpArticles)
      .where(eq(helpArticles.slug, 'refund-policy'));
    await app.fetch(new Request(`http://t/api/help/${agentId}/refund-policy`));
    // the bump is fire-and-forget — give the update a tick to land
    await new Promise((r) => setTimeout(r, 50));
    const after = await db
      .select({ v: helpArticles.viewCount })
      .from(helpArticles)
      .where(eq(helpArticles.slug, 'refund-policy'));
    expect(after[0].v).toBe(before[0].v + 1);
  });

  it('reports top-viewed and zero-result searches at /insights', async () => {
    await app.fetch(new Request(`http://t/api/help/${agentId}?q=nonexistent%20feature`));
    await app.fetch(new Request(`http://t/api/help/${agentId}?q=nonexistent%20feature`));

    const res = await app.fetch(
      new Request(`http://t/api/articles/insights?agent_id=${agentId}`, {
        headers: { cookie },
      }),
    );
    const body = await j(res);
    expect(res.status).toBe(200);
    const top = body.top_viewed as { title: string; viewCount: number }[];
    expect(top[0].title).toBe('Refund policy');
    expect(top[0].viewCount).toBeGreaterThanOrEqual(1);
    const missed = body.zero_result_searches as { query: string; n: number }[];
    const m = missed.find((x) => x.query === 'nonexistent feature');
    expect(m?.n).toBe(2);
  });
});
