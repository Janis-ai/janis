import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, helpArticles } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toHelpArticle } from '../lib/serializers.js';

const articleBody = z.object({
  agent_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(60).default('General'),
  body: z.string().max(60_000).default(''),
  status: z.enum(['draft', 'published']).default('draft'),
});

const articlePatch = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(60).optional(),
  body: z.string().max(60_000).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

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
        category: b.category,
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
        ...(b.category !== undefined ? { category: b.category } : {}),
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

  app.get('/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({
        id: helpArticles.id,
        title: helpArticles.title,
        category: helpArticles.category,
        body: helpArticles.body,
        updatedAt: helpArticles.updatedAt,
      })
      .from(helpArticles)
      .where(and(eq(helpArticles.agentId, agentId), eq(helpArticles.status, 'published')))
      .orderBy(asc(helpArticles.category), asc(helpArticles.position), asc(helpArticles.createdAt));
    // Group into categories, preserving sort order.
    const categories: { name: string; articles: { id: string; title: string; excerpt: string }[] }[] = [];
    for (const r of rows) {
      let cat = categories.find((g) => g.name === r.category);
      if (!cat) {
        cat = { name: r.category, articles: [] };
        categories.push(cat);
      }
      cat.articles.push({ id: r.id, title: r.title, excerpt: r.body.slice(0, 160) });
    }
    return c.json({ agent_name: agent.name, categories });
  });

  app.get('/:agentId/:articleId', async (c) => {
    const [row] = await db
      .select()
      .from(helpArticles)
      .innerJoin(agents, eq(helpArticles.agentId, agents.id))
      .where(
        and(
          eq(helpArticles.id, c.req.param('articleId')),
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
