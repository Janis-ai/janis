import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeFiles, shopifyShops } from '../db/schema.js';
import { decryptSecret } from './secrets.js';

/**
 * Shopify → knowledge sync (Phase 4). A bound shop gets two URL-backed
 * knowledge rows on its agent — 'shopify://catalog' and
 * 'shopify://policies' — which the regular URL-source refresh machinery
 * re-syncs on cadence (sweeper → knowledge.refresh job →
 * refreshKnowledgeSource). The shopify:// scheme branches there to these
 * Admin-GraphQL renderers instead of an HTTP crawl, so the agent answers
 * catalogue and policy questions from current store data with zero
 * merchant authoring.
 */

export const SHOPIFY_CATALOG_URL = 'shopify://catalog';
export const SHOPIFY_POLICIES_URL = 'shopify://policies';

const SHOPIFY_API_VERSION = '2026-10';
/** Knowledge-file rows live under Knowledge → Sources like any URL source. */
const REFRESH_HOURS = 24;
/** Cap the rendered catalog — a knowledge doc is a prompt ingredient, not
 *  the storefront. Bigger shops still get the truthful count line. */
const CATALOG_LIMIT = 60;

async function adminGql(shop: string, token: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`shopify graphql ${res.status}`);
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data ?? {};
}

type ProductNode = {
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  totalInventory?: number | null;
  description?: string;
  priceRangeV2?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
};

function money(p: ProductNode): string {
  const m = p.priceRangeV2?.minVariantPrice;
  if (!m?.amount) return '';
  return `${m.currencyCode ?? ''} ${m.amount}`.trim();
}

async function catalogText(shop: string, token: string): Promise<string> {
  const data = (await adminGql(
    shop,
    token,
    `query{productsCount{count} products(first:${CATALOG_LIMIT},query:"status:active",sortKey:TITLE){nodes{title handle vendor productType tags status totalInventory description(truncateAt:280) priceRangeV2{minVariantPrice{amount currencyCode}}}}}`,
  )) as { productsCount?: { count?: number }; products?: { nodes?: ProductNode[] } };
  const total = data.productsCount?.count ?? 0;
  const nodes = data.products?.nodes ?? [];
  const lines = [
    `Store catalog — synced ${new Date().toISOString().slice(0, 10)} from Shopify.`,
    `${total} active product${total === 1 ? '' : 's'} total${nodes.length < total ? ` — first ${nodes.length} listed alphabetically` : ''}.`,
    '',
  ];
  for (const p of nodes) {
    const bits = [
      `• ${p.title}`,
      p.vendor ? `by ${p.vendor}` : '',
      p.productType ? `[${p.productType}]` : '',
      money(p),
      p.totalInventory === 0 ? 'OUT OF STOCK' : '',
    ].filter(Boolean);
    lines.push(bits.join(' — '));
    lines.push(`  https://${shop}/products/${p.handle}`);
    if (p.description) lines.push(`  ${p.description}`);
  }
  return lines.join('\n');
}

/** shopPolicies bodies are HTML — strip to readable text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function policiesText(shop: string, token: string): Promise<string> {
  const data = (await adminGql(
    shop,
    token,
    '{shop{shopPolicies{type title body}}}',
  )) as { shop?: { shopPolicies?: { type: string; title: string; body: string }[] } };
  const policies = data.shop?.shopPolicies ?? [];
  if (!policies.length) return `No published store policies were found on ${shop}.`;
  const lines = [`Store policies — synced ${new Date().toISOString().slice(0, 10)} from Shopify.`, ''];
  for (const p of policies) {
    lines.push(`## ${p.title || p.type}`);
    lines.push(stripHtml(p.body ?? ''));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render a shopify:// knowledge row's text via the bound shop's offline
 * token. Called by refreshKnowledgeSource — same contract as fetchUrlText
 * ({text, sizeBytes, finalUrl}) so all the rot/degrade/last-good
 * machinery applies unchanged.
 */
export async function fetchShopifySourceText(
  db: Db,
  file: typeof knowledgeFiles.$inferSelect,
): Promise<{ text: string; sizeBytes: number; imageUrl: null; finalUrl: string }> {
  const [row] = await db
    .select()
    .from(shopifyShops)
    .where(eq(shopifyShops.agentId, file.agentId))
    .limit(1);
  if (!row?.accessTokenEnc) throw new Error('no Shopify shop bound to this agent');
  const token = decryptSecret(row.accessTokenEnc);
  const text =
    file.sourceUrl === SHOPIFY_CATALOG_URL
      ? await catalogText(row.shop, token)
      : await policiesText(row.shop, token);
  return { text, sizeBytes: Buffer.byteLength(text), imageUrl: null, finalUrl: file.sourceUrl! };
}

/**
 * Create the agent's two shopify:// knowledge rows if absent — idempotent,
 * called on bind and on every linked embedded load so shops bound before
 * this feature existed self-heal. nextFetchAt=now means the sweeper
 * performs the first sync within a tick.
 */
export async function ensureShopifyKnowledge(
  db: Db,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  for (const [sourceUrl, name] of [
    [SHOPIFY_CATALOG_URL, 'Shopify catalog'],
    [SHOPIFY_POLICIES_URL, 'Shopify store policies'],
  ] as const) {
    const [existing] = await db
      .select({ id: knowledgeFiles.id })
      .from(knowledgeFiles)
      .where(and(eq(knowledgeFiles.agentId, agentId), eq(knowledgeFiles.sourceUrl, sourceUrl)))
      .limit(1);
    if (existing) continue;
    await db.insert(knowledgeFiles).values({
      workspaceId,
      agentId,
      name,
      mimeType: 'text/plain',
      sizeBytes: 0,
      sourceUrl,
      refreshHours: REFRESH_HOURS,
      nextFetchAt: new Date(),
    });
  }
}

/** products/* webhook → pull the next catalog sync forward to now. */
export async function bumpCatalogSync(db: Db, agentId: string): Promise<void> {
  await db
    .update(knowledgeFiles)
    .set({ nextFetchAt: new Date() })
    .where(
      and(eq(knowledgeFiles.agentId, agentId), eq(knowledgeFiles.sourceUrl, SHOPIFY_CATALOG_URL)),
    );
}
