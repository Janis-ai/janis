import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles } from '../db/schema.js';
import { fetchPublic, htmlToText, SITE_SOURCE_MIME } from './urlSource.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_CHARS = 80_000;
const MAX_ZENDESK_PAGES = 10; // 100 per page — 1000 articles discovered at most
const MAX_SITEMAPS = 10; // index children + robots-listed files followed
const MAX_CRAWL_PAGES = 30; // BFS discovery — pages visited per import, inline
const MAX_CRAWL_DEPTH = 2; // root → section → leaf
const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|map|zip|tar|gz|mp[34]|mov|avi|xml|json|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf)$/i;

/** Upper bound on knowledge rows per agent — a help-centre import can fan
 *  out to hundreds of article sources. Prompt injection is separately capped
 *  (MAX_KNOWLEDGE_CHARS in hostedAgent) so extra rows can't blow the prompt. */
export const MAX_KNOWLEDGE_SOURCES = 500;

export interface HelpCentreImport {
  /** The site row the pages hang under — the KB list shows "site — N pages". */
  site: string;
  kind: 'zendesk' | 'sitemap' | 'crawl';
  /** Article URLs the centre advertised. */
  discovered: number;
  /** Children filled with article text inline (Zendesk API path). */
  imported: number;
  /** Stub children the sweeper re-crawls on the jobs path (sitemap path). */
  queued: number;
  /** URLs already present as sources — re-importing is idempotent. */
  skipped: number;
  /** Children that left the site's listing — disabled this pass, deleted
   *  on the next if still gone. */
  pruned: number;
  /** Previously-marked children that reappeared — re-enabled. */
  restored: number;
  /** True when the per-agent source cap truncated the import. */
  capped: boolean;
}

/** A discovered page: Zendesk articles carry their text inline, sitemap and
 *  link-crawl pages are URL-only stubs the sweeper fills. */
interface DiscoveredPage {
  url: string;
  title?: string;
  text?: string;
  sizeBytes?: number;
}

// authHeaders — operator-supplied per-import credentials; fetchPublic
// sends them on same-host hops only (a cross-host redirect drops them).
async function get(
  url: string,
  accept: string,
  authHeaders?: Record<string, string>,
): Promise<Response> {
  // SSRF-guarded hop-by-hop fetch — import roots are operator-pasted.
  return (
    await fetchPublic(
      url,
      {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'JanisKB/1.0 (+knowledge import)',
          accept,
        },
      },
      authHeaders,
    )
  ).res;
}

interface ZdArticle {
  html_url?: string;
  title?: string;
  body?: string;
  draft?: boolean;
}

/** Probe for Zendesk's public help-centre API — also present on host-mapped
 *  custom domains. Returns null when the origin isn't Zendesk-shaped. A
 *  pasted /hc/<locale>/… URL scopes the listing to that locale. */
async function zendeskArticles(
  root: URL,
  authHeaders?: Record<string, string>,
): Promise<ZdArticle[] | null> {
  const locale = root.pathname.match(/\/hc\/([a-z]{2}(?:-[a-zA-Z]+)?)(?:\/|$)/)?.[1];
  let pageUrl: string | null =
    `${root.origin}/api/v2/help_center/${locale ? `${locale}/` : ''}articles.json?per_page=100`;
  const out: ZdArticle[] = [];
  for (let page = 0; pageUrl && page < MAX_ZENDESK_PAGES; page++) {
    const res = await get(pageUrl, 'application/json', authHeaders).catch(() => null);
    if (!res?.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { articles?: ZdArticle[]; next_page?: string | null }
      | null;
    if (!Array.isArray(data?.articles)) return null;
    for (const a of data.articles) {
      if (a.html_url && a.title && a.draft !== true) out.push(a);
    }
    pageUrl = data.next_page ?? null;
  }
  return out.length ? out : null;
}

/** robots.txt Sitemap: directives, then /sitemap.xml — indexes recurse. */
async function sitemapUrls(root: URL, authHeaders?: Record<string, string>): Promise<string[]> {
  const queue: string[] = [];
  const robots = await get(`${root.origin}/robots.txt`, 'text/plain,*/*;q=0.5', authHeaders).catch(() => null);
  if (robots?.ok) {
    for (const line of (await robots.text()).split('\n')) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) queue.push(m[1]);
    }
  }
  queue.push(`${root.origin}/sitemap.xml`);

  const urls: string[] = [];
  const seen = new Set<string>();
  for (let n = 0; queue.length && n < MAX_SITEMAPS; ) {
    const loc = queue.shift()!;
    if (seen.has(loc)) continue;
    seen.add(loc);
    n++;
    const res = await get(loc, 'application/xml,text/xml,*/*;q=0.5', authHeaders).catch(() => null);
    if (!res?.ok) continue;
    const xml = await res.text();
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (isIndex) queue.push(m[1]);
      else urls.push(m[1]);
    }
  }
  return urls;
}

/** Same-host URLs under the pasted path — pasting .../hc/en-us scopes the
 *  import to that locale subtree, pasting the root keeps everything. */
function inScope(root: URL, urls: string[]): string[] {
  const prefix = root.pathname === '/' ? '/' : root.pathname.replace(/\/+$/, '') + '/';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    try {
      const p = new URL(u);
      if (p.host !== root.host) continue;
      if (prefix !== '/' && !p.pathname.startsWith(prefix)) continue;
      if (seen.has(p.href)) continue;
      seen.add(p.href);
      out.push(p.href);
    } catch {
      // not a URL — skip
    }
  }
  return out;
}

/** Same-host page links, canonicalised — fragment and query stripped so
 *  ?sort= permutations can't fan the crawl out. */
function extractLinks(html: string, page: URL): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#]+)/gi)) {
    try {
      const u = new URL(m[1], page);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      u.search = '';
      out.push(u.href);
    } catch {
      // unparseable href — skip
    }
  }
  return out;
}

/** Whether a URL sits under the pasted path scope on the same host —
 *  pasting .../docs scopes the crawl to the /docs subtree, the root keeps
 *  the whole site. Mirrors inScope's prefix rule for a single candidate. */
function inScopeUrl(root: URL, href: string): boolean {
  const prefix = root.pathname === '/' ? '/' : root.pathname.replace(/\/+$/, '') + '/';
  try {
    const p = new URL(href);
    return p.host === root.host && (prefix === '/' || p.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

/** Sites with no sitemap — BFS same-host links from the pasted page, staying
 *  inside its path scope. Discovery only; stub rows are filled by the
 *  sweeper's re-crawl like the sitemap path. Bounded pages+depth keeps the
 *  request-time crawl polite and finite. */
async function crawlUrls(root: URL, authHeaders?: Record<string, string>): Promise<string[]> {
  const start = new URL(root.href);
  start.hash = '';
  start.search = '';
  const seen = new Set([start.href]);
  const queue: { url: string; depth: number }[] = [{ url: start.href, depth: 0 }];
  const found: string[] = [];
  let visited = 0;
  while (queue.length && visited < MAX_CRAWL_PAGES) {
    const { url, depth } = queue.shift()!;
    visited++;
    const res = await get(url, 'text/html,*/*;q=0.5', authHeaders).catch(() => null);
    if (!res?.ok) continue;
    if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('html')) continue;
    found.push(url);
    if (depth >= MAX_CRAWL_DEPTH) continue;
    for (const link of extractLinks(await res.text(), new URL(url))) {
      if (seen.has(link) || !inScopeUrl(root, link) || SKIP_EXT.test(link)) continue;
      seen.add(link);
      queue.push({ url: link, depth: depth + 1 });
    }
  }
  return found;
}

/** Page discovery — the same ladder the import walks (Zendesk's public
 *  articles API, then the site's own sitemap, then a bounded link BFS),
 *  shared with the 24h re-check so a site row's refresh IS rediscovery.
 *  Zendesk articles arrive with text; the other paths return URL stubs.
 *  Throws when nothing under the pasted path is discoverable — callers
 *  treat that as a failed crawl, not "the site is empty" (a transient
 *  outage must never evict a working site). */
async function discoverSite(
  root: URL,
  authHeaders?: Record<string, string>,
): Promise<{ kind: HelpCentreImport['kind']; pages: DiscoveredPage[] }> {
  const zd = await zendeskArticles(root, authHeaders);
  if (zd) {
    return {
      kind: 'zendesk',
      pages: zd.map((a) => ({
        url: a.html_url!,
        title: a.title,
        text: htmlToText(a.body ?? '')
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
          .trim()
          .slice(0, MAX_ARTICLE_CHARS),
        sizeBytes: Buffer.byteLength(a.body ?? ''),
      })),
    };
  }

  // Sitemap first — the site's own page list is the most complete. When it
  // yields nothing under the pasted path, BFS the site's own links instead.
  const scoped = inScope(root, await sitemapUrls(root, authHeaders));
  const crawled = scoped.length ? [] : await crawlUrls(root, authHeaders);
  const found = scoped.length ? scoped : crawled;
  const kind = scoped.length ? 'sitemap' : 'crawl';
  // The pasted page is a page too — sitemaps don't always list the root.
  const rootHref = new URL(root.href);
  rootHref.hash = '';
  rootHref.search = '';
  const urls = [...new Set([rootHref.href, ...found])];
  if (!found.length) {
    throw new Error(
      'no pages found — not a Zendesk API, no sitemap URLs, and no crawlable links under that path',
    );
  }
  return { kind, pages: urls.map((url) => ({ url })) };
}

/** Error marker on a child whose URL left the site's listing. Marks are
 *  restorable (the page comes back → re-enabled) and become the delete
 *  signal on the NEXT pass — a single thin sitemap can't evict a page. */
const LEFT_SITE = 'no longer listed on the site — excluded (auto-restored if it returns)';

/**
 * Diff a site row's children against freshly discovered pages:
 *  - new URL → child row (filled inline when the discovery carried text,
 *    else a stub the sweeper's per-page re-crawl fills)
 *  - child still listed → untouched (or un-marked if it had left before)
 *  - child missing → disabled + marked; already-marked and still missing →
 *    deleted. Auth headers, cadence, and topic inherit from the site row.
 */
export async function syncSiteChildren(
  db: Db,
  site: typeof knowledgeFiles.$inferSelect,
  pages: DiscoveredPage[],
): Promise<Omit<HelpCentreImport, 'site' | 'kind' | 'discovered'>> {
  const [children, sources, [rowCount]] = await Promise.all([
    db.select().from(knowledgeFiles).where(eq(knowledgeFiles.parentId, site.id)),
    db
      .select({ id: knowledgeFiles.id, sourceUrl: knowledgeFiles.sourceUrl })
      .from(knowledgeFiles)
      .where(and(eq(knowledgeFiles.agentId, site.agentId), isNotNull(knowledgeFiles.sourceUrl))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, site.agentId)),
  ]);
  // Dedupe against every other source row EXCEPT the site row itself — its
  // own URL doubles as the root child, which is how the homepage stays in.
  const have = new Set(sources.filter((r) => r.id !== site.id).map((r) => r.sourceUrl));
  const childByUrl = new Map(children.map((c) => [c.sourceUrl, c]));
  const listed = new Set(pages.map((p) => p.url));
  let slots = MAX_KNOWLEDGE_SOURCES - rowCount.count;
  const now = new Date();
  const next = new Date(now.getTime() + (site.refreshHours ?? 24) * 3600_000);
  const out = { imported: 0, queued: 0, skipped: 0, pruned: 0, restored: 0, capped: false };

  for (const page of pages) {
    const child = childByUrl.get(page.url);
    if (child) {
      if (!child.enabled && child.error === LEFT_SITE) {
        await db
          .update(knowledgeFiles)
          .set({ enabled: true, error: null, refreshHours: site.refreshHours, nextFetchAt: now })
          .where(eq(knowledgeFiles.id, child.id));
        out.restored++;
      } else {
        out.skipped++;
      }
      continue;
    }
    if (have.has(page.url)) {
      out.skipped++;
      continue;
    }
    if (slots-- <= 0) {
      out.capped = true;
      break;
    }
    const text = page.text ?? '';
    await db.insert(knowledgeFiles).values({
      workspaceId: site.workspaceId,
      agentId: site.agentId,
      parentId: site.id,
      name: (page.title ?? page.url).slice(0, 500),
      mimeType: 'text/url-source',
      sizeBytes: page.sizeBytes ?? 0,
      text,
      status: page.text === undefined || text ? 'ready' : 'failed',
      error: page.text === undefined || text ? null : 'article had no readable text',
      sourceUrl: page.url,
      sourceHeadersEnc: site.sourceHeadersEnc,
      topic: site.topic,
      refreshHours: site.refreshHours,
      // A filled child is fresh now; a stub goes to the head of the
      // sweeper's bounded re-crawl queue.
      lastFetchedAt: text ? now : null,
      nextFetchAt: text ? next : now,
    });
    have.add(page.url);
    if (text) out.imported++;
    else out.queued++;
  }

  for (const child of children) {
    if (!child.sourceUrl || listed.has(child.sourceUrl)) continue;
    if (child.enabled) {
      // refreshHours null keeps the row off the re-crawl queue — a lucky
      // refetch would clear the mark and the page could never be pruned.
      await db
        .update(knowledgeFiles)
        .set({ enabled: false, error: LEFT_SITE, refreshHours: null, nextFetchAt: null })
        .where(eq(knowledgeFiles.id, child.id));
      out.pruned++;
    } else if (child.error === LEFT_SITE) {
      await db.delete(knowledgeFiles).where(eq(knowledgeFiles.id, child.id));
      out.pruned++;
    }
  }
  return out;
}

/** Site-row refresh — what the sweeper calls instead of a page refetch.
 *  Re-runs discovery and diffs the children; throws when the site can't be
 *  discovered at all (the caller degrades the row, children keep serving
 *  their last-good text). */
export async function refreshSiteSource(
  db: Db,
  site: typeof knowledgeFiles.$inferSelect,
  authHeaders?: Record<string, string>,
): Promise<{ kind: HelpCentreImport['kind'] } & Omit<HelpCentreImport, 'site' | 'kind' | 'discovered'>> {
  const disc = await discoverSite(new URL(site.sourceUrl!), authHeaders);
  const sync = await syncSiteChildren(db, site, disc.pages);
  return { kind: disc.kind, ...sync };
}

/** Import a whole site as ONE knowledge row: the site is the parent,
 *  discovered pages hang under it as children. Zendesk centres fill
 *  children inline from the articles API; sitemap/link discovery leaves
 *  stubs for the sweeper's bounded re-crawl. Re-importing the same root
 *  rides the existing site row — it's a rediscovery, not a second site. */
export async function importHelpCentre(
  db: Db,
  workspaceId: string,
  agentId: string,
  url: string,
  refreshHours: number,
  auth: { headers?: Record<string, string>; headersEnc?: string } = {},
  opts: { topic?: string } = {},
): Promise<HelpCentreImport> {
  const root = new URL(url);
  const prior = await db
    .select({ id: knowledgeFiles.id, mimeType: knowledgeFiles.mimeType, sourceUrl: knowledgeFiles.sourceUrl })
    .from(knowledgeFiles)
    .where(and(eq(knowledgeFiles.agentId, agentId), isNotNull(knowledgeFiles.sourceUrl)));
  if (prior.length >= MAX_KNOWLEDGE_SOURCES)
    throw new Error(`knowledge source limit reached (${MAX_KNOWLEDGE_SOURCES})`);
  const priorSite = prior.find(
    (r) => r.mimeType === SITE_SOURCE_MIME && r.sourceUrl === url,
  );
  // Discovery BEFORE any row write — a total failure leaves nothing behind.
  const disc = await discoverSite(root, auth.headers);

  const now = new Date();
  let site: typeof knowledgeFiles.$inferSelect;
  if (priorSite) {
    [site] = (await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.id, priorSite.id)))!;
  } else {
    [site] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId,
        agentId,
        name: url.slice(0, 500),
        mimeType: SITE_SOURCE_MIME,
        sizeBytes: 0,
        text: '',
        status: 'ready',
        sourceUrl: url,
        // Auth headers persist (encrypted) so the cadence re-crawl
        // authenticates identically — children inherit them.
        ...(auth.headersEnc ? { sourceHeadersEnc: auth.headersEnc } : {}),
        topic: opts.topic ?? null,
        refreshHours,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + refreshHours * 3600_000),
      })
      .returning();
  }
  const sync = await syncSiteChildren(db, site, disc.pages);
  return { site: site.id, kind: disc.kind, discovered: disc.pages.length, ...sync };
}
