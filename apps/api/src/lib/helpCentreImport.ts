import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles } from '../db/schema.js';
import { htmlToText } from './urlSource.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_CHARS = 80_000;
const MAX_ZENDESK_PAGES = 10; // 100 per page — 1000 articles discovered at most
const MAX_SITEMAPS = 10; // index children + robots-listed files followed

/** Upper bound on knowledge rows per agent — a help-centre import can fan
 *  out to hundreds of article sources. Prompt injection is separately capped
 *  (MAX_KNOWLEDGE_CHARS in hostedAgent) so extra rows can't blow the prompt. */
export const MAX_KNOWLEDGE_SOURCES = 500;

export interface HelpCentreImport {
  kind: 'zendesk' | 'sitemap';
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
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'user-agent': 'JanisKB/1.0 (+knowledge import)',
      accept,
    },
  });
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

/** Import a whole help centre as per-article URL knowledge sources. Zendesk
 *  centres fill rows inline from the articles API; anything else falls back
 *  to the sitemap and leaves stub rows for the sweeper's bounded re-crawl. */
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

  const scoped = inScope(root, await sitemapUrls(root));
  if (!scoped.length) {
    throw new Error(
      'no help centre found — not a Zendesk API and no sitemap URLs under that path',
    );
  }
  let queued = 0;
  let skipped = 0;
  let capped = false;
  for (const u of scoped) {
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
  return { kind: 'sitemap', discovered: scoped.length, imported: 0, queued, skipped, capped };
}
