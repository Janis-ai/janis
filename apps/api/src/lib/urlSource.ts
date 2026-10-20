import dns from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles } from '../db/schema.js';
import { fireEventWebhook } from './eventWebhook.js';
import { decryptSecret } from './secrets.js';
import { fetchShopifySourceText } from './shopifySync.js';

const MAX_CHARS = 80_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// ── SSRF guard ──────────────────────────────────────────────────────────
// URL knowledge sources are operator-pasted but the fetch is server-side:
// without a guard, any workspace admin can point the crawler at the cloud
// metadata service (169.254.169.254 returns live service-account tokens on
// GCP) or internal addresses and read the response back as knowledge text.
// Literal-hostname checks alone aren't enough — a public hostname can
// resolve to a private IP — so resolved addresses are checked too.

type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;
let lookupAll: LookupAll = async (h) => dns.lookup(h, { all: true, verbatim: true });
/** Test hook — unit tests stub fetch, so DNS is stubbed the same way. */
export function setHostLookupForTests(fn: LookupAll | null): void {
  lookupAll = fn ?? (async (h) => dns.lookup(h, { all: true, verbatim: true }));
}

/** IPv4 dotted-quad plus IPv6 checks: loopback, link-local, private ranges,
 *  CGNAT, multicast. Anything else is treated as global unicast. */
function isPublicIp(addr: string): boolean {
  if (addr.includes(':')) {
    const a = addr.toLowerCase();
    if (a === '::' || a === '::1') return false;
    if (/^fe[89ab]/.test(a)) return false; // link-local fe80::/10
    if (/^f[cd]/.test(a)) return false; // unique-local fc00::/7
    if (a.startsWith('ff')) return false; // multicast ff00::/8
    const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPublicIp(mapped[1]) : true;
  }
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Cheap literal check — no DNS. Covers hostnames that are themselves
 *  private/internal (also used by the emitted-link checker in hostedAgent). */
export function publiclyFetchable(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname;
    if (h.includes(':')) return false; // ipv6 literal — block outright
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(h)) return false;
    if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    return m ? isPublicIp(h) : true;
  } catch {
    return false;
  }
}

/** Full guard — literal check plus DNS resolution. Throws with a reason. */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (!publiclyFetchable(raw)) throw new Error(`refusing to fetch non-public URL ${raw}`);
  const { hostname } = new URL(raw);
  if (hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return; // literal already checked
  let addrs: { address: string }[] = [];
  try {
    addrs = await lookupAll(hostname);
  } catch {
    return; // resolution failed — the fetch itself will surface the same error
  }
  if (addrs.some((a) => !isPublicIp(a.address)))
    throw new Error(`refusing to fetch ${hostname} — resolves to a private address`);
}

/** Guarded fetch — every redirect hop is re-checked before it is followed,
 *  so a public URL can't 302 into an internal one. `authHeaders` (per-source
 *  credentials) are only sent while the hop stays on the origin host —
 *  a cross-host redirect drops them so a public page can't bounce the
 *  crawler into exfiltrating the token. Returns the final response and
 *  the URL it actually came from. */
export async function fetchPublic(
  url: string,
  init?: RequestInit,
  authHeaders?: Record<string, string>,
): Promise<{ res: Response; finalUrl: string }> {
  let current = url;
  const originHost = new URL(url).host;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const sameHost = new URL(current).host === originHost;
    const headers =
      authHeaders && sameHost
        ? { ...(init?.headers as Record<string, string> | undefined), ...authHeaders }
        : init?.headers;
    const res = await fetch(current, { ...init, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, finalUrl: current };
    const loc = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!loc) return { res, finalUrl: current };
    if (hop + 1 >= MAX_REDIRECTS) throw new Error(`too many redirects fetching ${url}`);
    current = new URL(loc, current).href;
  }
}

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

/** Rewrite known URL shapes into the form that actually returns content —
 *  a Google Doc /edit link yields the editor shell, not the text; the export
 *  endpoint yields the doc. Pure function; the stored source_url is the
 *  rewritten form so every re-crawl hits it too. */
export function normalizeSourceUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const gdoc = u.hostname === 'docs.google.com'
    ? u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/)
    : null;
  if (gdoc) {
    const format = gdoc[1] === 'spreadsheets' ? 'csv' : 'txt';
    return `https://docs.google.com/${gdoc[1]}/d/${gdoc[2]}/export?format=${format}`;
  }
  const gh = u.hostname === 'github.com'
    ? u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/)
    : null;
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  return raw;
}

/** Fetch a URL and return its knowledge text. Throws on network/HTTP errors.
 *  `headers` carries per-source auth (Notion tokens, private docs) —
 *  operator-supplied on the source row, decrypted just before the fetch. */
export async function fetchUrlText(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ text: string; sizeBytes: number; imageUrl?: string; finalUrl: string }> {
  const { res, finalUrl } = await fetchPublic(
    url,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A polite crawler identity — some hosts block the default UA.
        'user-agent': 'JanisKB/1.0 (+knowledge refresh)',
        accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
      },
    },
    opts.headers,
  );
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
    imageUrl: isHtml ? pageImageUrl(raw, finalUrl) : undefined,
    finalUrl,
  };
}

// A re-crawl that lands on a different registrable host (docs.google.com →
// accounts.google.com sign-in wall) or that shrinks the text to under ~30%
// of what it was is almost certainly rot — a revoked share, an expired page,
// a parked domain — not an update. 'www.'/apex hops are benign.
const ROT_SHRINK_RATIO = 0.3;
const ROT_MIN_PRIOR_CHARS = 500;

function rotReason(prior: string, sourceUrl: string, text: string, finalUrl: string): string | null {
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const [srcHost, finalHost] = [hostOf(sourceUrl), hostOf(finalUrl)];
  if (srcHost && finalHost && srcHost !== finalHost)
    return `page redirected off-site (${srcHost} → ${finalHost}) — keeping last-good text`;
  if (prior.length >= ROT_MIN_PRIOR_CHARS && text.length < prior.length * ROT_SHRINK_RATIO)
    return `page shrank to ${Math.round((100 * text.length) / prior.length)}% of last-good — keeping previous text`;
  return null;
}

/**
 * Re-crawl one URL-backed knowledge row. On success the text is swapped in
 * place — the agent's next reply uses fresh content with no operator action.
 * The failure modes keep last-good text serving:
 *  - fetch failed/rot detected with prior content → 'degraded' (still
 *    injected into the prompt; the error explains it's stale). A single bad
 *    crawl must never evict a working document from the agent's knowledge.
 *  - failure with nothing ever fetched → 'failed' (there is no last-good).
 * Retries stay on the configured cadence, never faster.
 */
export async function refreshKnowledgeSource(
  db: Db,
  file: typeof knowledgeFiles.$inferSelect,
): Promise<boolean> {
  const now = new Date();
  const intervalMs = (file.refreshHours ?? 24) * 3600_000;
  const sourceEvent = (event: string, extra: Record<string, unknown> = {}) =>
    fireEventWebhook(db, file.workspaceId, event, {
      fileId: file.id,
      agentId: file.agentId,
      name: file.name,
      sourceUrl: file.sourceUrl,
      ...extra,
    });
  const degrade = async (reason: string) => {
    const entersDegraded = !!file.text && file.status !== 'degraded';
    await db
      .update(knowledgeFiles)
      .set({
        status: file.text ? 'degraded' : 'failed',
        error: reason,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + intervalMs),
      })
      .where(eq(knowledgeFiles.id, file.id));
    // Page the workspace's event hook on the ready→degraded transition only —
    // repeated failed re-crawls of an already-degraded row don't re-page.
    if (entersDegraded) sourceEvent('knowledge_source.degraded', { reason });
    return false;
  };
  try {
    // shopify://catalog|policies rows render from the bound shop's Admin
    // API instead of an HTTP crawl — same update/degrade contract either
    // way (a wiped catalog still trips the shrink guard like page rot).
    // Authenticated sources decrypt their headers just for the fetch.
    let sourceHeaders: Record<string, string> | undefined;
    if (file.sourceHeadersEnc) {
      try {
        sourceHeaders = JSON.parse(decryptSecret(file.sourceHeadersEnc));
      } catch {
        sourceHeaders = undefined;
      }
    }
    const { text, sizeBytes, imageUrl, finalUrl } = file.sourceUrl!.startsWith('shopify://')
      ? await fetchShopifySourceText(db, file)
      : await fetchUrlText(file.sourceUrl!, { headers: sourceHeaders });
    const rot = rotReason(file.text ?? '', file.sourceUrl!, text, finalUrl);
    if (rot) return degrade(rot);
    // No-change crawls keep the last-good row but skip the text/size
    // rewrite — textChangedAt stays put so "when did this doc actually
    // change" survives N identical crawls.
    const unchanged = text === (file.text ?? '');
    await db
      .update(knowledgeFiles)
      .set({
        ...(unchanged ? {} : { text, sizeBytes, textChangedAt: now }),
        imageUrl: imageUrl ?? null,
        status: 'ready',
        error: null,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + intervalMs),
      })
      .where(eq(knowledgeFiles.id, file.id));
    if (file.status === 'degraded') sourceEvent('knowledge_source.recovered');
    return true;
  } catch (err) {
    return degrade(`last fetch failed — serving previous text (${err instanceof Error ? err.message : 'fetch failed'})`);
  }
}
