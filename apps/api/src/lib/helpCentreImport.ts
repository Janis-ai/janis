import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles } from '../db/schema.js';
import { fetchPublic, htmlToText } from './urlSource.js';

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
  kind: 'zendesk' | 'sitemap' | 'crawl';
  /** Article URLs the centre advertised. */
  discovered: number;
  /** Rows filled with article text inline (Zendesk API path). */
  imported: number;
  /** Stub rows the sweeper re-crawls on the jobs path (sitemap path). */
  queued: number;
  /** URLs already present as sources — re-importing is idempotent. */
  skipped: number;
  /** True when the per-agent source cap truncated the import. */
  capped: boolean;
}

async function get(url: string, accept: string): Promise<Response> {
  // SSRF-guarded hop-by-hop fetch — import roots are operator-pasted.
  return (
    await fetchPublic(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'JanisKB/1.0 (+knowledge import)',
        accept,
      },
    })
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
async function zendeskArticles(root: URL): Promise<ZdArticle[] | null> {
  const locale = root.pathname.match(/\/hc\/([a-z]{2}(?:-[a-zA-Z]+)?)(?:\/|$)/)?.[1];
  let pageUrl: string | null =
    `${root.origin}/api/v2/help_center/${locale ? `${locale}/` : ''}articles.json?per_page=100`;
  const out: ZdArticle[] = [];
  for (let page = 0; pageUrl && page < MAX_ZENDESK_PAGES; page++) {
    const res = await get(pageUrl, 'application/json').catch(() => null);
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
async function sitemapUrls(root: URL): Promise<string[]> {
  const queue: string[] = [];
  const robots = await get(`${root.origin}/robots.txt`, 'text/plain,*/*;q=0.5').catch(() => null);
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
    const res = await get(loc, 'application/xml,text/xml,*/*;q=0.5').catch(() => null);
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
async function crawlUrls(root: URL): Promise<string[]> {
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
    const res = await get(url, 'text/html,*/*;q=0.5').catch(() => null);
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

/** Import a whole help centre as per-article URL knowledge sources. Zendesk
 *  centres fill rows inline from the articles API; anything else falls back
 *  to the sitemap and leaves stub rows for the sweeper's bounded re-crawl.
 *  No sitemap either → a bounded link crawl from the pasted page. */
export async function importHelpCentre(
  db: Db,
  workspaceId: string,
  agentId: string,
  url: string,
  refreshHours: number,
): Promise<HelpCentreImport> {
  const root = new URL(url);
  const existing = await db
    .select({ sourceUrl: knowledgeFiles.sourceUrl })
    .from(knowledgeFiles)
    .where(
      and(eq(knowledgeFiles.agentId, agentId), isNotNull(knowledgeFiles.sourceUrl)),
    );
  const have = new Set(existing.map((r) => r.sourceUrl));
  let slots = MAX_KNOWLEDGE_SOURCES - existing.length;
  if (slots <= 0) throw new Error(`knowledge source limit reached (${MAX_KNOWLEDGE_SOURCES})`);

  const now = new Date();
  const next = new Date(now.getTime() + refreshHours * 3600_000);
  const base = {
    workspaceId,
    agentId,
    mimeType: 'text/url-source',
    refreshHours,
  };

  const zd = await zendeskArticles(root);
  if (zd) {
    let imported = 0;
    let skipped = 0;
    let capped = false;
    for (const a of zd) {
      if (have.has(a.html_url!)) {
        skipped++;
        continue;
      }
      if (slots-- <= 0) {
        capped = true;
        break;
      }
      const text = htmlToText(a.body ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .trim()
        .slice(0, MAX_ARTICLE_CHARS);
      await db.insert(knowledgeFiles).values({
        ...base,
        name: a.title!.slice(0, 500),
        sizeBytes: Buffer.byteLength(a.body ?? ''),
        text,
        status: text ? 'ready' : 'failed',
        error: text ? null : 'article had no readable text',
        sourceUrl: a.html_url,
        lastFetchedAt: now,
        nextFetchAt: next,
      });
      have.add(a.html_url!);
      imported++;
    }
    return { kind: 'zendesk', discovered: zd.length, imported, queued: 0, skipped, capped };
  }

  // Sitemap first — the site's own page list is the most complete. When it
  // yields nothing under the pasted path, BFS the site's own links instead.
  const scoped = inScope(root, await sitemapUrls(root));
  const crawled = scoped.length ? [] : await crawlUrls(root);
  const discovered = scoped.length ? scoped : crawled;
  const kind = scoped.length ? 'sitemap' : 'crawl';
  if (!discovered.length) {
    throw new Error(
      'no pages found — not a Zendesk API, no sitemap URLs, and no crawlable links under that path',
    );
  }
  let queued = 0;
  let skipped = 0;
  let capped = false;
  for (const u of discovered) {
    if (have.has(u)) {
      skipped++;
      continue;
    }
    if (slots-- <= 0) {
      capped = true;
      break;
    }
    // Stub row — nextFetchAt=now puts it at the head of the sweeper's
    // bounded re-crawl queue, which fills text + the real next slot.
    await db.insert(knowledgeFiles).values({
      ...base,
      name: u,
      sizeBytes: 0,
      text: '',
      sourceUrl: u,
      lastFetchedAt: null,
      nextFetchAt: now,
    });
    have.add(u);
    queued++;
  }
  return { kind, discovered: discovered.length, imported: 0, queued, skipped, capped };
}
