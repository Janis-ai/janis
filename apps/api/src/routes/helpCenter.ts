import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, helpArticles, workspaces } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toHelpArticle } from '../lib/serializers.js';

const slugRe = /^[a-z0-9][a-z0-9-]{0,80}$/;
const seoField = z.string().max(300).nullable().optional();

const articleBody = z.object({
  agent_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  slug: z.string().regex(slugRe).nullable().optional(),
  category: z.string().min(1).max(60).default('General'),
  seo_title: seoField,
  seo_description: seoField,
  body: z.string().max(60_000).default(''),
  status: z.enum(['draft', 'published']).default('draft'),
});

const articlePatch = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z.string().regex(slugRe).nullable().optional(),
  category: z.string().min(1).max(60).optional(),
  seo_title: seoField,
  seo_description: seoField,
  body: z.string().max(60_000).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'article'
  );
}

/** Unique slug for an article within its agent — appends -2, -3… on clash. */
async function uniqueSlug(db: Db, agentId: string, base: string, excludeId?: string) {
  const rows = await db
    .select({ id: helpArticles.id, slug: helpArticles.slug })
    .from(helpArticles)
    .where(eq(helpArticles.agentId, agentId));
  const taken = new Set(
    rows.filter((r) => r.id !== excludeId).map((r) => r.slug).filter((s): s is string => Boolean(s)),
  );
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

async function ownsAgent(db: Db, workspaceId: string, agentId: string) {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

async function ownsArticle(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(helpArticles)
    .innerJoin(agents, eq(helpArticles.agentId, agents.id))
    .where(and(eq(helpArticles.id, id), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return row?.help_articles ?? null;
}

/** Console CRUD — manage an agent's help-center articles. */
export function articleRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('*', sessionAuth(db));

  app.get('/', zValidator('query', z.object({ agent_id: z.string().uuid() })), async (c) => {
    const { agent_id } = c.req.valid('query');
    if (!(await ownsAgent(db, c.get('workspaceId'), agent_id)))
      return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(helpArticles)
      .where(eq(helpArticles.agentId, agent_id))
      .orderBy(asc(helpArticles.category), asc(helpArticles.position), asc(helpArticles.createdAt));
    return c.json({ articles: rows.map(toHelpArticle) });
  });

  app.post('/', zValidator('json', articleBody), async (c) => {
    const b = c.req.valid('json');
    if (!(await ownsAgent(db, c.get('workspaceId'), b.agent_id)))
      return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .insert(helpArticles)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: b.agent_id,
        title: b.title,
        slug: await uniqueSlug(db, b.agent_id, b.slug ?? slugify(b.title)),
        category: b.category,
        seoTitle: b.seo_title ?? null,
        seoDescription: b.seo_description ?? null,
        body: b.body,
        status: b.status,
        publishedAt: b.status === 'published' ? new Date() : null,
      })
      .returning();
    return c.json({ article: toHelpArticle(row) }, 201);
  });

  app.patch('/:id', zValidator('json', articlePatch), async (c) => {
    const existing = await ownsArticle(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    const b = c.req.valid('json');
    const publishing = b.status === 'published' && existing.status !== 'published';
    const [row] = await db
      .update(helpArticles)
      .set({
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.slug !== undefined
          ? { slug: b.slug === null ? null : await uniqueSlug(db, existing.agentId, b.slug, existing.id) }
          : {}),
        ...(b.category !== undefined ? { category: b.category } : {}),
        ...(b.seo_title !== undefined ? { seoTitle: b.seo_title } : {}),
        ...(b.seo_description !== undefined ? { seoDescription: b.seo_description } : {}),
        ...(b.body !== undefined ? { body: b.body } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
        publishedAt: publishing ? new Date() : existing.publishedAt,
        updatedAt: new Date(),
      })
      .where(eq(helpArticles.id, existing.id))
      .returning();
    return c.json({ article: toHelpArticle(row) });
  });

  app.delete('/:id', async (c) => {
    const existing = await ownsArticle(db, c.get('workspaceId'), c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);
    await db.delete(helpArticles).where(eq(helpArticles.id, existing.id));
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Customer-facing read endpoints — no session. Only published articles on
 * existing agents are reachable; drafts never leak. Mounted at /api/help.
 */
export function helpPublicRoutes(db: Db) {
  const app = new Hono();

  // GET /domain?host=help.acme.com — resolves a CNAME'd help domain to the
  // workspace that claimed it (config.help_domain) so a custom domain can
  // serve the help index at its root.
  app.get('/domain', async (c) => {
    const host = (c.req.query('host') ?? c.req.header('host') ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (!host) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(sql`${workspaces.config}->>'help_domain' = ${host}`)
      .limit(1);
    const ws = rows[0];
    if (!ws) return c.json({ error: 'not found' }, 404);
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.workspaceId, ws.id));
    // Only surface agents that actually have published articles.
    const withArticles = [];
    for (const a of agentRows) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(helpArticles)
        .where(and(eq(helpArticles.agentId, a.id), eq(helpArticles.status, 'published')));
      if (n > 0) withArticles.push(a);
    }
    if (!withArticles.length) return c.json({ error: 'not found' }, 404);
    return c.json({ workspace_name: ws.name, agents: withArticles });
  });

  app.get('/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const q = (c.req.query('q') ?? '').trim();
    const conds = [eq(helpArticles.agentId, agentId), eq(helpArticles.status, 'published')];
    if (q) {
      const like = `%${q}%`;
      conds.push(or(ilike(helpArticles.title, like), ilike(helpArticles.body, like))!);
    }
    const rows = await db
      .select({
        id: helpArticles.id,
        slug: helpArticles.slug,
        title: helpArticles.title,
        category: helpArticles.category,
        body: helpArticles.body,
        updatedAt: helpArticles.updatedAt,
      })
      .from(helpArticles)
      .where(and(...conds))
      .orderBy(asc(helpArticles.category), asc(helpArticles.position), asc(helpArticles.createdAt));
    // Group into categories, preserving sort order.
    const categories: {
      name: string;
      articles: { id: string; slug: string | null; title: string; excerpt: string }[];
    }[] = [];
    for (const r of rows) {
      let cat = categories.find((g) => g.name === r.category);
      if (!cat) {
        cat = { name: r.category, articles: [] };
        categories.push(cat);
      }
      cat.articles.push({ id: r.id, slug: r.slug, title: r.title, excerpt: r.body.slice(0, 160) });
    }
    return c.json({ agent_name: agent.name, categories });
  });

  // :articleId accepts a slug or the uuid — slugs are the public-facing
  // permalink; ids keep older links and internal fetches working.
  app.get('/:agentId/:articleId', async (c) => {
    const key = c.req.param('articleId');
    const byId = /^[0-9a-f-]{36}$/i.test(key);
    const [row] = await db
      .select()
      .from(helpArticles)
      .innerJoin(agents, eq(helpArticles.agentId, agents.id))
      .where(
        and(
          byId ? eq(helpArticles.id, key) : eq(helpArticles.slug, key),
          eq(helpArticles.agentId, c.req.param('agentId')),
          eq(helpArticles.status, 'published'),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent_name: row.agents.name, article: toHelpArticle(row.help_articles) });
  });

  return app;
}
