import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles } from '../db/schema.js';

const MAX_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Strip HTML to readable text — script/style dropped, tags collapsed to
 *  whitespace, common entities decoded. Good enough for FAQ/help pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|nav|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** The page's best image — og:/twitter:image first (what the site itself
 *  promotes), else the first content-looking <img> (logo/icon/sprite srces
 *  skipped). Resolved against the page URL so protocol-relative and
 *  root-relative srces survive. Knowledge text drops every tag, so this is
 *  the only image URL the agent will ever see for a crawled page. */
function pageImageUrl(html: string, pageUrl: string): string | undefined {
  const metas = html.match(/<meta[^>]+>/gi) ?? [];
  let src: string | undefined;
  for (const tag of metas) {
    if (!/(?:property|name)=["'](?:og:image|twitter:image)/i.test(tag)) continue;
    src = /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) break;
  }
  if (!src) {
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      if (/logo|icon|sprite|blank|pixel|spacer|avatar|badge|\.svg(?:$|\?)/i.test(m[1])) continue;
      src = m[1];
      break;
    }
  }
  if (!src || src.startsWith('data:')) return undefined;
  // Meta/img attributes are HTML-encoded — &amp;/&#x3D; in a stored URL
  // resolves to a literal entity the CDN can't parse, so decode first.
  src = src
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  try {
    const u = new URL(src, pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href.slice(0, 500);
  } catch {
    return undefined;
  }
}

/** Fetch a URL and return its knowledge text. Throws on network/HTTP errors. */
export async function fetchUrlText(
  url: string,
): Promise<{ text: string; sizeBytes: number; imageUrl?: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('only http(s) URLs are supported');
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // A polite crawler identity — some hosts block the default UA.
      'user-agent': 'JanisKB/1.0 (+knowledge refresh)',
      accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
    },
  });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const raw = await res.text();
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const isHtml = type.includes('html');
  const text = (isHtml ? htmlToText(raw) : raw)
    // strip nulls/control chars that break DB storage and prompt quality
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .slice(0, MAX_CHARS);
  if (!text) throw new Error('page had no readable text');
  return {
    text,
    sizeBytes: Buffer.byteLength(raw),
    imageUrl: isHtml ? pageImageUrl(raw, res.url || url) : undefined,
  };
}

/**
 * Re-crawl one URL-backed knowledge row. On success the text is swapped in
 * place — the agent's next reply uses fresh content with no operator action.
 * On failure the row keeps its last-good text but is flagged failed with the
 * error visible in the console, and the retry is scheduled for the same
 * cadence (a down page retries hourly/whatever was configured, never faster).
 */
export async function refreshKnowledgeSource(
  db: Db,
  file: typeof knowledgeFiles.$inferSelect,
): Promise<boolean> {
  const now = new Date();
  const intervalMs = (file.refreshHours ?? 24) * 3600_000;
  try {
    const { text, sizeBytes, imageUrl } = await fetchUrlText(file.sourceUrl!);
    await db
      .update(knowledgeFiles)
      .set({
        text,
        sizeBytes,
        imageUrl: imageUrl ?? null,
        status: 'ready',
        error: null,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + intervalMs),
      })
      .where(eq(knowledgeFiles.id, file.id));
    return true;
  } catch (err) {
    await db
      .update(knowledgeFiles)
      .set({
        status: 'failed',
        error: err instanceof Error ? err.message : 'fetch failed',
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + intervalMs),
      })
      .where(eq(knowledgeFiles.id, file.id));
    return false;
  }
}
