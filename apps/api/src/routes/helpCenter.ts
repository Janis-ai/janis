import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, helpArticles, helpSearchLog, helpVotes, workspaces } from '../db/schema.js';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownsArticle(db: Db, workspaceId: string, id: string) {
  if (!UUID_RE.test(id)) return null; // garbage path param → 404, not a PG error
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

  // Content roadmap: most-viewed articles + the searches that found nothing.
  app.get('/insights', zValidator('query', z.object({ agent_id: z.string().uuid() })), async (c) => {
    const { agent_id } = c.req.valid('query');
    if (!(await ownsAgent(db, c.get('workspaceId'), agent_id)))
      return c.json({ error: 'not found' }, 404);
    const topViewed = await db
      .select({
        id: helpArticles.id,
        title: helpArticles.title,
        slug: helpArticles.slug,
        category: helpArticles.category,
        viewCount: helpArticles.viewCount,
        helpful:
          sql<number>`(select count(*) filter (where helpful) from help_votes where article_id = ${helpArticles.id})::int`,
        notHelpful:
          sql<number>`(select count(*) filter (where not helpful) from help_votes where article_id = ${helpArticles.id})::int`,
      })
      .from(helpArticles)
      .where(eq(helpArticles.agentId, agent_id))
      .orderBy(desc(helpArticles.viewCount))
      .limit(10);
    const missed = (await db.execute(sql`
      select lower(query) as query, count(*)::int as n, max(created_at) as last_seen
      from help_search_log
      where agent_id = ${agent_id} and results = 0
      group by lower(query)
      order by n desc, last_seen desc
      limit 20
    `)) as unknown;
    const missedRows = (Array.isArray(missed) ? missed : (missed as { rows?: unknown[] }).rows) ?? [];
    // Articles readers flagged unhelpful — the fix list alongside the
    // zero-result content roadmap.
    const disliked = await db
      .select({
        id: helpArticles.id,
        title: helpArticles.title,
        slug: helpArticles.slug,
        notHelpful: sql<number>`count(*) filter (where not ${helpVotes.helpful})::int`,
        helpful: sql<number>`count(*) filter (where ${helpVotes.helpful})::int`,
      })
      .from(helpVotes)
      .innerJoin(helpArticles, eq(helpVotes.articleId, helpArticles.id))
      .where(eq(helpArticles.agentId, agent_id))
      .groupBy(helpArticles.id)
      .orderBy(desc(sql`count(*) filter (where not ${helpVotes.helpful})`))
      .limit(10);
    return c.json({
      top_viewed: topViewed,
      zero_result_searches: missedRows,
      satisfaction: disliked.filter((a) => a.helpful + a.notHelpful > 0),
    });
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

  // GET /domain?host=help.acme.com — resolves a CNAME'd help domain. An
  // agent-level override (agents.config.help_domain) wins and serves just
  // that agent's centre; otherwise the workspace claim (config.help_domain)
  // lists every agent with published articles.
  app.get('/domain', async (c) => {
    const host = (c.req.query('host') ?? c.req.header('host') ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (!host) return c.json({ error: 'not found' }, 404);
    const [override] = await db
      .select({ id: agents.id, name: agents.name, workspaceId: agents.workspaceId })
      .from(agents)
      .where(sql`${agents.config}->>'help_domain' = ${host}`)
      .limit(1);
    if (override) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(helpArticles)
        .where(and(eq(helpArticles.agentId, override.id), eq(helpArticles.status, 'published')));
      if (n > 0) {
        const [ws] = await db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, override.workspaceId))
          .limit(1);
        return c.json({ workspace_name: ws?.name ?? '', agents: [{ id: override.id, name: override.name }] });
      }
      // A claimed domain with nothing published falls through to a
      // workspace-level claim rather than 404ing on an unrelated centre.
    }
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
    if (!UUID_RE.test(agentId)) return c.json({ error: 'not found' }, 404);
    const [agent] = await db
      .select({ id: agents.id, name: agents.name, workspaceId: agents.workspaceId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const q = (c.req.query('q') ?? '').trim();
    const conds = [eq(helpArticles.agentId, agentId), eq(helpArticles.status, 'published')];
    // Ranked lexical search: tsvector over title+body (generated column,
    // GIN index) OR'd with ILIKE so queries with no English lexemes
    // ("09xx" phone prefixes, codes) still match verbatim.
    if (q) {
      const like = `%${q}%`;
      conds.push(
        sql`(search_vector @@ websearch_to_tsquery('english', ${q})
             or ${helpArticles.title} ilike ${like}
             or ${helpArticles.body} ilike ${like})`,
      );
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
      .orderBy(
        // Rank only applies when searching — 0 for the ILIKE-only matches,
        // which then fall through to the catalog order.
        ...(q ? [sql`ts_rank(search_vector, websearch_to_tsquery('english', ${q})) desc` as never] : []),
        asc(helpArticles.category),
        asc(helpArticles.position),
        asc(helpArticles.createdAt),
      );
    // Every search is logged — results=0 rows are the content roadmap.
    if (q) {
      await db.insert(helpSearchLog).values({
        workspaceId: agent.workspaceId,
        agentId,
        query: q.slice(0, 300),
        results: rows.length,
      });
    }
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
    const agentId = c.req.param('agentId');
    if (!UUID_RE.test(agentId)) return c.json({ error: 'not found' }, 404);
    const key = c.req.param('articleId');
    const byId = /^[0-9a-f-]{36}$/i.test(key);
    const [row] = await db
      .select()
      .from(helpArticles)
      .innerJoin(agents, eq(helpArticles.agentId, agents.id))
      .where(
        and(
          byId ? eq(helpArticles.id, key) : eq(helpArticles.slug, key),
          eq(helpArticles.agentId, agentId),
          eq(helpArticles.status, 'published'),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    // Fire-and-forget read counter — the insights endpoint ranks on it.
    // (drizzle builders only execute on .then — a bare `void` would never run.)
    void db
      .update(helpArticles)
      .set({ viewCount: sql`${helpArticles.viewCount} + 1` })
      .where(eq(helpArticles.id, row.help_articles.id))
      .catch(() => {});
    return c.json({ agent_name: row.agents.name, article: toHelpArticle(row.help_articles) });
  });

  // "Was this helpful?" — anonymous, deduped by a fingerprint of the
  // reader (IP + UA, hashed with the article id); re-voting flips the row
  // rather than double-counting. Public surface, so keep it write-light.
  app.post(
    '/:agentId/:articleId/vote',
    zValidator('json', z.object({ helpful: z.boolean() })),
    async (c) => {
      const agentId = c.req.param('agentId');
      if (!UUID_RE.test(agentId)) return c.json({ error: 'not found' }, 404);
      const key = c.req.param('articleId');
      const byId = /^[0-9a-f-]{36}$/i.test(key);
      const [article] = await db
        .select({ id: helpArticles.id })
        .from(helpArticles)
        .where(
          and(
            byId ? eq(helpArticles.id, key) : eq(helpArticles.slug, key),
            eq(helpArticles.agentId, agentId),
            eq(helpArticles.status, 'published'),
          ),
        )
        .limit(1);
      if (!article) return c.json({ error: 'not found' }, 404);
      const fp = createHash('sha256')
        .update(
          `${c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? ''}|` +
            `${c.req.header('user-agent') ?? ''}|${article.id}`,
        )
        .digest('hex')
        .slice(0, 40);
      await db
        .insert(helpVotes)
        .values({ articleId: article.id, helpful: c.req.valid('json').helpful, voter: fp })
        .onConflictDoUpdate({
          target: [helpVotes.articleId, helpVotes.voter],
          set: { helpful: c.req.valid('json').helpful },
        });
      return c.json({ ok: true });
    },
  );

  return app;
}
