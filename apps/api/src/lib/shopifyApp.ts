import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import {
  agentSecrets,
  agents,
  auditLog,
  channels,
  contacts,
  conversations,
  knowledgeFiles,
  messages,
  shopifyShops,
  users,
  workspaces,
} from '../db/schema.js';
import { PLANS } from './plans.js';
import { encryptSecret } from './secrets.js';
import { adminToken, clearMirroredSecrets, mirrorSecrets } from './shopifyToken.js';
import { audit } from './audit.js';
import { sendEmail } from './notify.js';
import { dispatchAlert, openAlertOnce } from './alerts.js';
import { invalidateChannelCache } from './channels.js';
import { purgeContactData } from './contacts.js';
import { bumpCatalogSync, ensureShopifyKnowledge } from './shopifySync.js';
import { systemNote } from './systemNote.js';
import { enqueueJob } from './jobs.js';
import { runHostedEvent } from './hostedAgent.js';
import { filterDismissedGaps, gapsCacheFresh, readGapsCache } from '../services/knowledgeGaps.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';
import { TOOL_TEMPLATES } from './toolTemplates.js';
import { generateWebhookSecret } from './crypto.js';
import { generateDraft } from './agentBuilder.js';

/**
 * Shopify App Store install plumbing — the embedded app (Partner Dashboard,
 * SHOPIFY_APP_API_KEY/SECRET) connects a merchant's shop to a Janis agent.
 *
 * Install path (managed install / token exchange — Shopify's recommended
 * flow for embedded apps, replaces the OAuth redirect dance):
 *   admin iframe loads /shopify-app → App Bridge idToken() (HS256 JWT
 *   signed with the app secret, aud = api key) → POST /api/shopify/session
 *   → verify → upsert shopify_shops → exchange the session token for an
 *   OFFLINE Admin API token → register webhooks → merchant completes the
 *   shop ↔ agent link in the console (signed link-code opens app.janis.ai).
 *
 * Linking mirrors the offline token into the bound agent's SHOPIFY_SHOP /
 * SHOPIFY_TOKEN secrets so shopify_* tools resolve like a PAT connect —
 * the app becomes the credential dispenser instead of the merchant.
 */

// Same version the shopify_* tool defs target (toolTemplates.ts) — probe-verified live.
export const SHOPIFY_API_VERSION = '2026-10';
const LINK_CODE_TTL_MS = 30 * 60 * 1000;
// The Shopify session token is a ~90s bootstrap credential — once /session
// verifies it we hand back this Janis-minted JWT so the iframe's subsequent
// calls never depend on App Bridge minting (idToken can serve stale cache
// entries in a backgrounded iframe).
const EMBEDDED_SESSION_TTL_S = 12 * 3600;

export function shopifyAppConfigured(): boolean {
  return Boolean(env.shopifyAppApiKey && env.shopifyAppApiSecret);
}

/* ── Session-token JWT (App Bridge idToken) ─────────────────────────── */

/** Verify an App Bridge session token — HS256 signed with the app secret,
 *  aud = api key, iss/dest pin it to one *.myshopify.com shop. Returns the
 *  shop domain plus the staff member's Shopify user id (sub) — the inbox
 *  attributes replies to them. */
export function verifySessionToken(token: string): { shop: string; sub?: string } | null {
  // Rejections log a reason so production failures are diagnosable — the
  // embedded app's only signal otherwise is a bare "invalid session token".
  const reject = (reason: string, extra?: Record<string, unknown>) => {
    console.warn('[shopify] session token rejected:', reason, extra ?? '');
    return null;
  };
  const [h, p, s] = (token ?? '').split('.');
  if (!h || !p || !s) return reject('malformed');
  if (!env.shopifyAppApiSecret) return reject('no_secret');
  const expected = createHmac('sha256', env.shopifyAppApiSecret)
    .update(`${h}.${p}`)
    .digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected))
    return reject('bad_signature');

  let claims: {
    iss?: string;
    dest?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    sub?: string | number;
  };
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return reject('bad_payload');
  }
  const now = Date.now() / 1000;
  if (!claims.exp || claims.exp < now - 30)
    return reject('expired', { exp: claims.exp, now: Math.floor(now) });
  if (claims.nbf && claims.nbf > now + 30)
    return reject('not_yet_valid', { nbf: claims.nbf, now: Math.floor(now) });
  const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  if (aud !== env.shopifyAppApiKey) return reject('aud', { aud });

  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : '';
    } catch {
      return '';
    }
  };
  const shop = host(claims.dest);
  // Session tokens always identify the shop by its myshopify domain even
  // when the storefront runs on a custom domain — pin both claims to it.
  if (!shop.endsWith('.myshopify.com')) return reject('dest', { dest: claims.dest });
  // Our own embedded session: iss is 'janis-embedded', not the shop admin —
  // same signature/exp/aud/dest guarantees, no iss pinning.
  if (claims.iss !== 'janis-embedded' && host(claims.iss) !== shop)
    return reject('iss', { iss: claims.iss, dest: claims.dest });
  return { shop, sub: claims.sub != null ? String(claims.sub) : undefined };
}

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Mint the embedded session JWT — verified by the same verifySessionToken
 *  path (iss='janis-embedded'), valid 12h, carries the staff sub so inbox
 *  replies keep their attribution across Shopify token refreshes. */
export function mintEmbeddedSession(shop: string, sub?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: 'HS256', typ: 'JWT' });
  const p = b64u({
    iss: 'janis-embedded',
    dest: `https://${shop}`,
    aud: env.shopifyAppApiKey,
    iat: now,
    exp: now + EMBEDDED_SESSION_TTL_S,
    ...(sub != null ? { sub } : {}),
  });
  const s = createHmac('sha256', env.shopifyAppApiSecret!)
    .update(`${h}.${p}`)
    .digest('base64url');
  return `${h}.${p}.${s}`;
}

/* ── Webhook HMAC ────────────────────────────────────────────────────── */

/** X-Shopify-Hmac-Sha256 — base64 HMAC-SHA256 of the RAW body with the app
 *  secret. Must run before any JSON.parse (the signature is over bytes). */
export function verifyWebhookHmac(raw: string, header: string | undefined): boolean {
  if (!header || !env.shopifyAppApiSecret) return false;
  const expected = createHmac('sha256', env.shopifyAppApiSecret).update(raw).digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── Storefront app proxy — verified shopper identity ──────────────────
 *
 * The theme embed's widget fetches /apps/janis/session on the SHOP domain.
 * Shopify proxies it to /api/shopify/proxy/session, signing the request
 * itself: `signature` is a hex HMAC-SHA256 (app secret) of the sorted
 * query params, and Shopify adds logged_in_customer_id when the visitor
 * holds a customer-account session. A valid signature is therefore real
 * proof of the shopper's store login — unlike the theme embed's
 * cid/cemail params, which are forgeable and stay self-reported. */

/** Verify a proxied request: drop `signature`, sort remaining params by
 *  key, render each `key=v1,v2` (multi-values sorted + comma-joined),
 *  concatenate, HMAC-SHA256 hex with the app secret. */
export function verifyProxySig(q: Record<string, string | string[] | undefined>): boolean {
  const sigRaw = q.signature;
  const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
  if (!sig || !env.shopifyAppApiSecret) return false;
  const pairs = Object.keys(q)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => {
      const v = q[k];
      const vals = (Array.isArray(v) ? v : [v])
        .filter((x): x is string => typeof x === 'string')
        .sort();
      return `${k}=${vals.join(',')}`;
    });
  const expected = createHmac('sha256', env.shopifyAppApiSecret)
    .update(pairs.join(''))
    .digest('hex');
  return (
    expected.length === sig.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  );
}

export interface ShopifyIdentityClaim {
  id: string;
  email?: string;
  name?: string;
  sig: string;
}

// The claim only changes when the customer edits their record — cache per
// shop+cid so a page-view-heavy storefront doesn't hit the Admin API per
// load. Single-instance deploy keeps an in-process map honest.
const claimCache = new Map<string, { at: number; claim: ShopifyIdentityClaim | null }>();
const CLAIM_TTL_MS = 5 * 60_000;

/** Mint a channel-signed identity claim for a Shopify-signed customer id.
 *  The proxy proved the login; the Admin API supplies the authoritative
 *  email/name; the channel's identity_secret signs the claim the widget
 *  sends → identity_verified + external_id 'shopify:<cid>' on the
 *  conversation, unlocking identity-bound tools for the real customer. */
export async function shopifyCustomerClaim(
  db: Db,
  shop: string,
  cid: string,
): Promise<ShopifyIdentityClaim | null> {
  const cacheKey = `${shop}:${cid}`;
  const hit = claimCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CLAIM_TTL_MS) return hit.claim;

  const finish = (claim: ShopifyIdentityClaim | null) => {
    claimCache.set(cacheKey, { at: Date.now(), claim });
    return claim;
  };

  const [row] = await db
    .select()
    .from(shopifyShops)
    .where(eq(shopifyShops.shop, shop))
    .limit(1);
  if (row?.state !== 'linked' || !row.agentId || !row.accessTokenEnc) return finish(null);
  const chans = await db
    .select({ id: channels.id, credentials: channels.credentials })
    .from(channels)
    .where(and(eq(channels.agentId, row.agentId), eq(channels.kind, 'webchat')));
  const chan = chans.find(
    (ch) => !(ch.credentials as { internal?: boolean } | null)?.internal,
  );
  if (!chan) return finish(null);

  // Identity claims need a signing secret — Shopify-linked channels get one
  // lazily here rather than at a separate setup step.
  const creds = (chan.credentials ?? {}) as { identity_secret?: string };
  let secret = creds.identity_secret;
  if (!secret) {
    secret = randomBytes(24).toString('hex');
    await db
      .update(channels)
      .set({ credentials: { ...creds, identity_secret: secret } })
      .where(eq(channels.id, chan.id));
    invalidateChannelCache();
  }

  const tok = await adminToken(db, row).catch(() => null);
  if (!tok) return finish(null);
  const res = await shopifyGraphql(
    shop,
    tok,
    `query{customer(id:"gid://shopify/Customer/${cid}"){email displayName firstName lastName}}`,
  );
  const cust = (res.data as { customer?: { email?: string; displayName?: string; firstName?: string; lastName?: string } } | undefined)?.customer;
  if (!cust) return finish(null);
  const name =
    cust.displayName?.trim() ||
    [cust.firstName, cust.lastName].filter(Boolean).join(' ').trim() ||
    undefined;
  const claim = { id: `shopify:${cid}`, email: cust.email || undefined, name };
  const sig = createHmac('sha256', secret)
    .update(`${claim.id}|${claim.email ?? ''}|${claim.name ?? ''}`)
    .digest('hex');
  return finish({ ...claim, sig });
}

/* ── Token exchange + Admin API calls ───────────────────────────────── */

interface OfflineToken {
  access_token: string;
  scope: string;
  // Present only on expiring-token responses (public apps MUST request
  // `expiring: 1` — Shopify rejects non-expiring tokens on the Admin API).
  expires_in?: number;
  refresh_token?: string;
}

/** Session token → offline Admin API token (managed install). Requests an
 *  expiring token — 1h access token + 90d refresh token; adminToken()
 *  refreshes through the refresh_token grant when it ages out. */
async function exchangeOfflineToken(shop: string, sessionToken: string): Promise<OfflineToken> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.shopifyAppApiKey,
      client_secret: env.shopifyAppApiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: 1,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<OfflineToken> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `token exchange failed (${res.status})`);
  }
  return {
    access_token: data.access_token,
    scope: data.scope ?? '',
    expires_in: data.expires_in,
    refresh_token: data.refresh_token,
  };
}

export async function shopifyGraphql(
  shop: string,
  token: string,
  query: string,
): Promise<{ data?: unknown; errors?: { message: string }[] }> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': token,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json().catch(() => ({}))) as { data?: unknown; errors?: { message: string }[] };
}

/** Subscriptions every install gets: lifecycle (uninstall — the mandatory
 *  GDPR topics are declared in app config instead) + the Phase 4
 *  order/refund/product events. All sit under the granted scopes —
 *  orders/* and refunds/* need read_orders, products/* read_products. */
const WEBHOOK_TOPICS = [
  'APP_UNINSTALLED',
  'ORDERS_CREATE',
  'ORDERS_FULFILLED',
  'REFUNDS_CREATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  // Billing rail: subscription status changes (approve/cancel/freeze).
  'APP_SUBSCRIPTIONS_UPDATE',
  // Abandoned-checkout signal — checkout activity on a known shopper's
  // thread; the proactive nudge builds on this (read_checkouts scope).
  'CHECKOUTS_UPDATE',
] as const;

export async function registerWebhooks(shop: string, token: string): Promise<void> {
  const cbUrl = `${env.apiOrigin}/shopify/webhooks`;
  const existing = await shopifyGraphql(
    shop,
    token,
    `{ webhookSubscriptions(first: 50) { nodes { endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } topic } } }`,
  );
  const nodes =
    (existing.data as { webhookSubscriptions?: { nodes?: { topic: string; endpoint?: { callbackUrl?: string } }[] } })
      ?.webhookSubscriptions?.nodes ?? [];
  // Idempotent — checks before creating. Best-effort: a failure logs and
  // the install still succeeds; the session endpoint retries on the next
  // embedded load anyway.
  const have = new Set(nodes.filter((n) => n.endpoint?.callbackUrl === cbUrl).map((n) => n.topic));
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) continue;
    const created = await shopifyGraphql(
      shop,
      token,
      `mutation { webhookSubscriptionCreate(topic: ${topic}, webhookSubscription: {callbackUrl: ${JSON.stringify(cbUrl)}, format: JSON}) { webhookSubscription { id } userErrors { field message } } }`,
    );
    const errs =
      (created.data as { webhookSubscriptionCreate?: { userErrors?: { message: string }[] } })
        ?.webhookSubscriptionCreate?.userErrors ?? [];
    if (errs.length)
      console.error(`shopify webhook register ${shop} ${topic}:`, errs.map((e) => e.message).join(', '));
  }
}

/* ── Link codes (signed, stateless — same scheme as Calendly intent) ─── */

export function signLinkCode(shopId: string, ttlMs = LINK_CODE_TTL_MS): string {
  const body = Buffer.from(JSON.stringify({ s: shopId, x: Date.now() + ttlMs })).toString(
    'base64url',
  );
  const sig = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyLinkCode(code: string): { shopId: string } | null {
  const [body, sig] = (code ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const i = JSON.parse(Buffer.from(body, 'base64url').toString()) as { s?: string; x?: number };
    return i.s && i.x && i.x > Date.now() ? { shopId: i.s } : null;
  } catch {
    return null;
  }
}

/* ── Console-access codes — emailed magic sign-in links for shop staff ── */

const ACCESS_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** Same HMAC scheme as link codes, but carries the destination email so a
 *  leaked code only signs in the person it was sent to. 24h — long enough
 *  to survive an inbox check on another device. */
export function signAccessCode(shopId: string, email: string): string {
  const body = Buffer.from(
    JSON.stringify({ s: shopId, e: email.toLowerCase(), x: Date.now() + ACCESS_CODE_TTL_MS }),
  ).toString('base64url');
  const sig = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAccessCode(code: string): { shopId: string; email: string } | null {
  const [body, sig] = (code ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const i = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      s?: string;
      e?: string;
      x?: number;
    };
    return i.s && i.e && i.x && i.x > Date.now() ? { shopId: i.s, email: i.e } : null;
  } catch {
    return null;
  }
}

/* ── Shop lifecycle ─────────────────────────────────────────────────── */

type ShopRow = typeof shopifyShops.$inferSelect;

/** Upsert the shop row on an embedded load and make sure it holds a live
 *  offline token. Also self-heals: a reinstall of a still-bound shop goes
 *  straight back to 'linked' with its secrets re-mirrored. */
export async function ensureShopForSession(
  db: Db,
  shop: string,
  sessionToken: string,
): Promise<ShopRow> {
  let [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop)).limit(1);
  if (!row) {
    [row] = await db
      .insert(shopifyShops)
      .values({ shop })
      .onConflictDoUpdate({
        target: shopifyShops.shop,
        set: { updatedAt: new Date() },
      })
      .returning();
  }

  // Exchange on every embedded load, not just the first: a token's scope set
  // is frozen at issuance, so an app-version scope bump (e.g. adding
  // write_draft_orders) only reaches the shop's tools through a fresh
  // exchange after the merchant re-consents. The exchange is cheap and the
  // response carries the current grant — Shopify's `scope` field lists
  // explicit grants (write_orders implicitly covers read_orders), so
  // re-issuing each load also self-heals a token revoked or rotated
  // elsewhere. If the exchange fails but a stored token exists, keep it —
  // a stale-scoped token beats a dead embedded page.
  let tok: OfflineToken | null = null;
  try {
    tok = await exchangeOfflineToken(shop, sessionToken);
  } catch (err) {
    if (!row.accessTokenEnc) throw err;
    console.error(`shopify token re-exchange ${shop}:`, err);
  }
  if (tok) {
    const reinstall = row.state === 'uninstalled';
    const updates: Partial<ShopRow> = {
      accessTokenEnc: encryptSecret(tok.access_token),
      scopes: tok.scope,
      updatedAt: new Date(),
    };
    // Expiring-token pair (public apps always get one); a legacy
    // non-expiring exchange leaves both null → adminToken() returns the
    // stored token without refreshing, exactly as before.
    updates.tokenExpiresAt =
      tok.expires_in && tok.expires_in > 0
        ? new Date(Date.now() + tok.expires_in * 1000)
        : null;
    updates.refreshTokenEnc = tok.refresh_token ? encryptSecret(tok.refresh_token) : null;
    // A reinstall with a surviving binding relinks straight away; with no
    // binding it must fall back to 'unlinked' or the embedded page is
    // stuck showing "install was removed" forever.
    if (reinstall) updates.state = row.workspaceId && row.agentId ? 'linked' : 'unlinked';
    [row] = await db
      .update(shopifyShops)
      .set(updates)
      .where(eq(shopifyShops.id, row.id))
      .returning();
    if (row.state === 'linked' && row.agentId && row.workspaceId) {
      await mirrorSecrets(db, row.agentId, row.workspaceId, shop, tok.access_token);
    }
    await registerWebhooks(shop, tok.access_token).catch((err) =>
      console.error(`shopify webhook register ${shop}:`, err),
    );
  } else if (row.state === 'linked' && row.agentId && row.workspaceId && row.accessTokenEnc) {
    // Re-mirror on every embedded load — a secret deleted since the link
    // self-heals here; adminToken() refreshes an aged-out token first so
    // the mirror never carries an expired value.
    await mirrorSecrets(db, row.agentId, row.workspaceId, shop, await adminToken(db, row));
  }
  // Idempotent shopify:// knowledge rows — covers installs bound before
  // the catalog/policy sync existed.
  if (row.state === 'linked' && row.agentId && row.workspaceId) {
    await ensureShopifyKnowledge(db, row.agentId, row.workspaceId).catch((err) =>
      console.error(`shopify knowledge ensure ${shop}:`, err),
    );
  }
  return row;
}

/** Console link — bind the shop to a workspace agent and hand the agent
 *  the shop credentials as secrets. */
export async function bindShop(
  db: Db,
  row: ShopRow,
  binding: { workspaceId: string; agentId: string },
): Promise<void> {
  // adminToken() refreshes an expiring token on the way out — the bind
  // shouldn't fail on a transient refresh hiccup, so degrade to no-mirror
  // (the next embedded load re-mirrors).
  const token = row.accessTokenEnc ? await adminToken(db, row).catch(() => '') : '';
  // One agent ↔ one shop: unlink any other row still pointing at this
  // agent so loaders/webhooks/catalog renders can't be served by a shop
  // the merchant moved away from.
  await db
    .update(shopifyShops)
    .set({ workspaceId: null, agentId: null, state: 'unlinked', updatedAt: new Date() })
    .where(and(eq(shopifyShops.agentId, binding.agentId), sql`${shopifyShops.id} != ${row.id}`));
  // The previously bound agent loses the store surface — its mirrored
  // secrets were only ever a copy, and its shopify:// knowledge rows can
  // never sync again. Tools stay: they degrade to a clean auth error and
  // the agent can be re-linked later.
  if (row.agentId && row.agentId !== binding.agentId) {
    await clearMirroredSecrets(db, row.agentId);
    await db
      .delete(knowledgeFiles)
      .where(and(eq(knowledgeFiles.agentId, row.agentId), like(knowledgeFiles.sourceUrl, 'shopify://%')));
  }
  await db
    .update(shopifyShops)
    .set({
      workspaceId: binding.workspaceId,
      agentId: binding.agentId,
      state: 'linked',
      updatedAt: new Date(),
    })
    .where(eq(shopifyShops.id, row.id));
  if (token) await mirrorSecrets(db, binding.agentId, binding.workspaceId, row.shop, token);
  // Land the catalog's shopify tools so a bound agent works with no
  // console install step — merge by name, same semantics as the
  // agents/tools/install route (an existing install upgrades in place).
  const tpl = TOOL_TEMPLATES.find((t) => t.id === 'shopify');
  if (tpl) {
    const [a] = await db
      .select({ config: agents.config })
      .from(agents)
      .where(eq(agents.id, binding.agentId))
      .limit(1);
    const cfg = (a?.config ?? {}) as { tools?: Array<{ name?: string }> };
    const names = new Set(tpl.tools.map((t) => t.name));
    const tools = [
      ...(cfg.tools ?? []).filter((t) => !names.has(t.name ?? '')),
      ...tpl.tools.map((t) => ({ ...t, template: tpl.id })),
    ];
    await db
      .update(agents)
      .set({ config: { ...cfg, tools } })
      .where(eq(agents.id, binding.agentId));
  }
  // Storefront channel — the theme app extension's loader resolves the
  // bound agent's Bubble; give it one if the agent doesn't already have a
  // customer-facing webchat (internal test chats don't count).
  const webchats = await db
    .select({ id: channels.id, credentials: channels.credentials })
    .from(channels)
    .where(and(eq(channels.agentId, binding.agentId), eq(channels.kind, 'webchat')));
  const external = webchats.filter(
    (ch) => !(ch.credentials as { internal?: boolean } | null)?.internal,
  );
  if (!external.length) {
    // Visitor-facing header — the shop's display name, not the myshopify
    // handle ("Shopify — janis-store-sx5bpcd3" reads wrong to customers).
    let shopName: string | undefined;
    if (token) {
      try {
        const res = await fetch(`https://${row.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-shopify-access-token': token,
          },
          body: JSON.stringify({ query: '{shop{name}}' }),
        });
        const json = (await res.json()) as { data?: { shop?: { name?: string } } };
        shopName = json.data?.shop?.name || undefined;
      } catch {
        // cosmetic — fall through to the handle-derived title
      }
    }
    await db.insert(channels).values({
      workspaceId: binding.workspaceId,
      agentId: binding.agentId,
      kind: 'webchat',
      name: `Shopify — ${row.shop.replace(/\.myshopify\.com$/, '')}`,
      credentials: { title: shopName ?? row.shop.replace(/\.myshopify\.com$/, '') },
    });
    invalidateChannelCache();
  }
  // shopify:// knowledge rows — catalog + policies sync on the URL-source
  // cadence from here on.
  await ensureShopifyKnowledge(db, binding.agentId, binding.workspaceId).catch((err) =>
    console.error(`shopify knowledge ensure ${row.shop}:`, err),
  );
  await audit(db, {
    workspaceId: binding.workspaceId,
    action: 'shopify.link',
    targetType: 'shopify_shop',
    targetId: row.id,
    meta: { shop: row.shop, agentId: binding.agentId },
  });
  // The merchant moved the shop to their own workspace — the provisioned
  // one is orphaned forever. Tear it down (ownerless, provisioned, and no
  // other shop still points at it) so unclaimed shells don't accumulate.
  if (row.workspaceId && row.workspaceId !== binding.workspaceId) {
    const [oldWs] = await db
      .select({ config: workspaces.config, ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    const otherShops = await db
      .select({ id: shopifyShops.id })
      .from(shopifyShops)
      .where(and(eq(shopifyShops.workspaceId, row.workspaceId), sql`${shopifyShops.id} != ${row.id}`))
      .limit(1);
    if (
      (oldWs?.config as { shopify_provisioned?: boolean } | null)?.shopify_provisioned &&
      !oldWs.ownerUserId &&
      !otherShops.length
    ) {
      await tearDownWorkspace(db, row.workspaceId).catch((err) =>
        console.error(`shopify orphan teardown ${row.shop}:`, err),
      );
    }
  }
}

/** Shopify staff member → a loginless Janis user row, so in-frame inbox
 *  replies/takeovers attribute to a real person ("Sarah took over") instead
 *  of a synthetic actor. The email is a deterministic synthetic address —
 *  password_hash stays null so the row can never sign in, and it holds no
 *  membership; it exists purely as an identity for audit + message
 *  authorship. Shopify gives us only the numeric staff sub — names/emails
 *  sit behind the gated read_users scope, so the label stays generic until
 *  console-access backfills a real address. */
export async function staffUserFor(
  db: Db,
  row: ShopRow,
  sub?: string,
): Promise<typeof users.$inferSelect> {
  const email = `shopify-staff+${sub || 'unknown'}@${row.shop}`;
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing;
  // Staff names/emails need the gated read_users scope (Plus/Advanced or
  // finance apps only — verified against Admin API 2026-10). The real
  // address lands on this row when the staff member requests console
  // access; until then the label is generic.
  const name = 'Store staff';
  await db.insert(users).values({ email, name }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return u;
}

/** Delete a workspace that only provision wrote — agents + their secrets,
 *  channels, knowledge and audit rows go first (no FK cascades on these),
 *  then the shell. Only used for ownerless auto-provisioned workspaces. */
async function tearDownWorkspace(db: Db, workspaceId: string): Promise<void> {
  const agIds = (
    await db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))
  ).map((a) => a.id);
  for (const id of agIds) {
    await db.delete(agentSecrets).where(eq(agentSecrets.agentId, id));
    await db.delete(channels).where(eq(channels.agentId, id));
    await db.delete(knowledgeFiles).where(eq(knowledgeFiles.agentId, id));
  }
  await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
  await db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

/** Zero-login install — an embedded session found an unlinked shop, so we
 *  provision the workspace + agent right there and bind it. The merchant's
 *  App Bridge token is the only credential involved; the workspace sits
 *  ownerless until they claim it via POST /api/shopify/claim. Billing rides
 *  the shop's AppSubscription (billing_provider='shopify'), never Stripe.
 *  provisioned_at is the atomic gate — parallel session loads can't
 *  double-provision, and unbindShop stamps it so a deliberate unlink is
 *  never auto-rebound on the next embedded load. */
export async function provisionShopWorkspace(db: Db, row: ShopRow): Promise<ShopRow> {
  const [claimed] = await db
    .update(shopifyShops)
    .set({ provisionedAt: new Date() })
    .where(and(eq(shopifyShops.id, row.id), isNull(shopifyShops.provisionedAt)))
    .returning();
  if (!claimed) return row; // a concurrent load is already provisioning

  let ws: typeof workspaces.$inferSelect | undefined;
  try {
    const token = row.accessTokenEnc ? await adminToken(db, row).catch(() => '') : '';
    let shopName = row.shop.replace(/\.myshopify\.com$/, '');
    let contactEmail: string | undefined;
    if (token) {
      try {
        const res = await fetch(`https://${row.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
          body: JSON.stringify({ query: '{shop{name contactEmail email}}' }),
        });
        const json = (await res.json()) as {
          data?: { shop?: { name?: string; contactEmail?: string; email?: string } };
        };
        shopName = json.data?.shop?.name || shopName;
        contactEmail = json.data?.shop?.contactEmail || json.data?.shop?.email || undefined;
      } catch {
        /* the handle-derived name is fine */
      }
    }
    // Persist the store's account email — console-access defaults to it
    // (staff emails need the gated read_users scope; this is all we get).
    if (contactEmail) {
      await db
        .update(shopifyShops)
        .set({ contactEmail })
        .where(eq(shopifyShops.id, row.id));
    }

    [ws] = await db
      .insert(workspaces)
      .values({
        name: shopName,
        plan: env.defaultPlan,
        billingProvider: 'shopify',
        config: { data_retention_days: 365, shopify_provisioned: true },
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: shopName.slice(0, 120),
        hosted: true,
        webhookSecret: generateWebhookSecret(),
        autoResumeMinutes: 10,
      })
      .returning();
    await bindShop(db, row, { workspaceId: ws.id, agentId: agent.id });
    await audit(db, {
      workspaceId: ws.id,
      action: 'shopify.provisioned',
      targetType: 'shopify_shop',
      targetId: row.id,
      meta: { shop: row.shop, workspace_id: ws.id, agent_id: agent.id },
    });

    // Install receipt — the merchant never created a Janis login, so email
    // the shop's contact address the claim link. 30-day TTL vs the in-app
    // 30-minute one: a receipt has to survive a weekend. Best-effort —
    // no Resend key / no contact email just skips it.
    if (contactEmail) {
      const claim = signLinkCode(row.id, 30 * 24 * 60 * 60 * 1000);
      void sendEmail(
        [contactEmail],
        `Your Janis assistant is live on ${shopName}`,
        `Hi — Janis just installed on your Shopify store ${shopName} (${row.shop}) and your AI storefront assistant is ready. It can answer product questions, look up orders, and chat with shoppers as soon as you enable the theme embed.\n\nWant the full console — conversations, knowledge base, settings? Claim your workspace here (sign in or create a free account):`,
        `/shopify-claim?code=${claim}`,
      ).catch((err) => console.error(`shopify install email ${row.shop}:`, err));
    }

    // Purpose-drafted config lands a beat later — the agent already works
    // (tools + catalog knowledge from bindShop); the draft just sharpens
    // the prompt, greeting and builder suggestions. Failure leaves the
    // bare agent, which is fine.
    const purpose = `You are the AI shopping assistant for ${shopName}, a Shopify store. Help visitors find products, check order status, and answer questions about shipping, returns and store policies — and help them complete purchases.`;
    void generateDraft(purpose)
      .then(async (draft) => {
        if (!draft) return;
        const [a] = await db
          .select({ config: agents.config })
          .from(agents)
          .where(eq(agents.id, agent.id))
          .limit(1);
        const existing = (a?.config ?? {}) as Record<string, unknown>;
        // The setup card may have already saved a different purpose or a
        // hand-edited greeting — the provision draft must not overwrite it.
        if (existing.purpose && existing.purpose !== purpose) return;
        const config = {
          ...existing,
          purpose,
          ...(draft.system_prompt ? { system_prompt: draft.system_prompt } : {}),
          ...(draft.tone ? { tone: draft.tone } : {}),
          ...(draft.greeting && !existing.greeting
            ? { greeting: draft.greeting, greeting_enabled: true }
            : {}),
          builder: { description: purpose, generated_at: new Date().toISOString() },
        };
        await db.update(agents).set({ config }).where(eq(agents.id, agent.id));
      })
      .catch((err) => console.error(`shopify provision draft ${row.shop}:`, err));
  } catch (err) {
    // Un-stamp the gate so the next embedded load retries — without this a
    // transient failure would strand the shop on the manual link flow. Take
    // the orphaned workspace down too: nothing references it yet, so the
    // child rows provision wrote (secrets/channels/knowledge) delete in
    // dependency order.
    await db.update(shopifyShops).set({ provisionedAt: null }).where(eq(shopifyShops.id, row.id));
    if (ws) {
      try {
        await tearDownWorkspace(db, ws.id);
      } catch {
        /* residue is an empty ownerless workspace — harmless */
      }
    }
    throw err;
  }

  const [fresh] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, row.id)).limit(1);
  return fresh;
}

/** Whether the Janis app embed is toggled on in the live theme. Reads the
 *  published theme's settings_data.json (read_themes scope) — app embeds
 *  land in current.blocks keyed by the client id. null = unknown (scope not
 *  granted yet, or the probe failed) — the caller falls back to the
 *  click-tracked flag. Cached briefly; this is a remote fetch on every
 *  embedded load otherwise. */
const embedCache = new Map<string, { v: boolean | null; exp: number }>();
export async function embedEnabled(db: Db, row: ShopRow): Promise<boolean | null> {
  const hit = embedCache.get(row.shop);
  if (hit && hit.exp > Date.now()) return hit.v;
  let out: boolean | null = null;
  try {
    const token = row.accessTokenEnc ? await adminToken(db, row).catch(() => null) : null;
    if (token) {
      const themesRes = await fetch(
        `https://${row.shop}/admin/api/${SHOPIFY_API_VERSION}/themes.json?role=main`,
        { headers: { 'x-shopify-access-token': token } },
      );
      if (themesRes.ok) {
        const { themes } = (await themesRes.json()) as { themes?: { id: number }[] };
        const themeId = themes?.[0]?.id;
        if (themeId) {
          const assetRes = await fetch(
            `https://${row.shop}/admin/api/${SHOPIFY_API_VERSION}/themes/${themeId}/assets.json?asset[key]=config/settings_data.json`,
            { headers: { 'x-shopify-access-token': token } },
          );
          if (assetRes.ok) {
            const { asset } = (await assetRes.json()) as { asset?: { value?: string } };
            const settings = JSON.parse(asset?.value ?? '{}') as {
              current?: { blocks?: Record<string, { type?: string; disabled?: boolean }> };
            };
            const blocks = Object.entries(settings.current?.blocks ?? {});
            const ours = blocks.find(
              ([key, b]) =>
                (key.startsWith(env.shopifyAppApiKey) || (b.type ?? '').includes('janis')) &&
                (b.type ?? '').includes('apps'),
            );
            if (ours) out = ours[1].disabled !== true;
          }
        }
      }
    }
  } catch {
    /* unknown — null */
  }
  embedCache.set(row.shop, { v: out, exp: Date.now() + 120_000 });
  return out;
}

/** Console unlink — the shop stays installed, the binding + mirrored
 *  secrets go away. */
export async function unbindShop(db: Db, row: ShopRow): Promise<void> {
  if (row.agentId) await clearMirroredSecrets(db, row.agentId);
  await db
    .update(shopifyShops)
    .set({
      workspaceId: null,
      agentId: null,
      state: 'unlinked',
      // Stamp the provision gate — a deliberate unlink means the merchant
      // wants manual control; the next embedded load must not auto-provision
      // a fresh workspace and silently rebind.
      provisionedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(shopifyShops.id, row.id));
  if (row.workspaceId) {
    await audit(db, {
      workspaceId: row.workspaceId,
      action: 'shopify.unlink',
      targetType: 'shopify_shop',
      targetId: row.id,
      meta: { shop: row.shop },
    });
  }
}

/** app/uninstalled — Shopify revokes the token itself; drop our copy and
 *  the mirrored secrets. The binding stays so a reinstall relinks cleanly. */
export async function uninstallShop(db: Db, shop: string): Promise<void> {
  const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop)).limit(1);
  if (!row) return;
  if (row.agentId) await clearMirroredSecrets(db, row.agentId);
  await db
    .update(shopifyShops)
    .set({
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      scopes: '',
      state: 'uninstalled',
      updatedAt: new Date(),
    })
    .where(eq(shopifyShops.id, row.id));
  if (row.workspaceId) {
    await audit(db, {
      workspaceId: row.workspaceId,
      action: 'shopify.uninstalled',
      targetType: 'shopify_shop',
      targetId: row.id,
      meta: { shop },
    });
  }
}

/* ── GDPR compliance topics (declared in app config, POSTed here) ────── */

/** customers/data_request — log it for the bound workspace so the merchant
 *  can hand the data over (audit trail is the compliance record). Returns
 *  the contact we found, if any. */
async function customerDataRequest(
  db: Db,
  row: ShopRow,
  payload: { customer?: { id?: number; email?: string } },
): Promise<void> {
  if (!row.workspaceId) return;
  const contact = await findShopCustomer(db, row.workspaceId, payload.customer);
  await audit(db, {
    workspaceId: row.workspaceId,
    action: 'shopify.gdpr.data_request',
    targetType: 'shopify_shop',
    targetId: row.id,
    meta: {
      shop: row.shop,
      customerId: payload.customer?.id,
      contactId: contact?.id ?? null,
      note: 'export via GET /api/contacts/:id/export',
    },
  });
}

/** customers/redact — erase the matching contact entirely. */
async function customerRedact(
  db: Db,
  row: ShopRow,
  payload: { customer?: { id?: number; email?: string } },
): Promise<void> {
  if (!row.workspaceId) return;
  const contact = await findShopCustomer(db, row.workspaceId, payload.customer);
  if (!contact) return;
  await purgeContactData(db, contact.id);
  await audit(db, {
    workspaceId: row.workspaceId,
    action: 'shopify.gdpr.redact',
    targetType: 'contact',
    targetId: contact.id,
    meta: { shop: row.shop, customerId: payload.customer?.id },
  });
}

/** A shop customer resolves to a contact by the shopify external id first
 *  (webhook-synced identities), falling back to the payload email. */
async function findShopCustomer(
  db: Db,
  workspaceId: string,
  customer?: { id?: number; email?: string },
): Promise<typeof contacts.$inferSelect | null> {
  if (customer?.id) {
    const [byExt] = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, workspaceId),
          sql`${contacts.externalIds}->>'shopify' = ${String(customer.id)}`,
        ),
      )
      .limit(1);
    if (byExt) return byExt;
  }
  if (customer?.email) {
    const [byEmail] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, customer.email)))
      .limit(1);
    return byEmail ?? null;
  }
  return null;
}

/** shop/redact — 48h after uninstall, everything about the shop goes. */
async function shopRedact(db: Db, row: ShopRow): Promise<void> {
  if (row.agentId) await clearMirroredSecrets(db, row.agentId);
  if (row.workspaceId) {
    await audit(db, {
      workspaceId: row.workspaceId,
      action: 'shopify.gdpr.shop_redact',
      targetType: 'shopify_shop',
      targetId: row.id,
      meta: { shop: row.shop },
    });
  }
  await db.delete(shopifyShops).where(eq(shopifyShops.id, row.id));
}

/** Dispatch a verified webhook. Returns false for unknown topics (caller
 *  still 200s — Shopify retries non-2xx and unknown topics aren't errors). */
/**
 * Order lifecycle events → an internal note on the customer's thread, so
 * the agent knows "they just ordered #1003 / it shipped / it was
 * refunded" the next time they chat. Refunds additionally fire a custom
 * alert — per the house rule, money going back out roped in a human.
 * Silent when the buyer never chatted (no contact = no thread to note).
 */
async function orderEventNote(
  db: Db,
  row: ShopRow,
  payload: Record<string, unknown>,
  kind: 'placed' | 'fulfilled' | 'refunded',
): Promise<void> {
  if (!row.agentId || !row.workspaceId) return;

  let email = (payload.email ??
    payload.contact_email ??
    (payload.customer as { email?: string } | undefined)?.email) as string | undefined;
  let name = payload.name as string | undefined;
  let total = (payload.total_price ?? payload.current_total_price) as string | undefined;
  let currency = (payload.currency ?? payload.presentment_currency) as string | undefined;
  // Refund payloads carry only ids — pull the order for the summary.
  if (kind === 'refunded' && payload.order_id && row.accessTokenEnc) {
    try {
      const data = await shopifyGraphql(
        row.shop,
        await adminToken(db, row),
        `query{order(id:"gid://shopify/Order/${payload.order_id}"){name email currentTotalPriceSet{shopMoney{amount currencyCode}}}}`,
      );
      const o = (
        data.data as {
          order?: {
            name?: string;
            email?: string;
            currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
          };
        }
      )?.order;
      name ??= o?.name;
      email ??= o?.email ?? undefined;
      total ??= o?.currentTotalPriceSet?.shopMoney?.amount;
      currency ??= o?.currentTotalPriceSet?.shopMoney?.currencyCode;
    } catch {
      /* the note still posts with whatever the payload gave us */
    }
  }

  const summary = `Shopify: order ${name ?? `#${payload.order_number ?? payload.id ?? ''}`} ${kind}${
    total ? ` — ${currency ?? ''} ${total}`.trimEnd() : ''
  }${email ? ` (${email})` : ''}`;

  if (!email) {
    console.log(`shopify webhook ${kind} ${row.shop}: no customer email — ${summary}`);
    return;
  }
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, row.workspaceId), eq(contacts.email, email)))
    .limit(1);
  if (!contact) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, contact.id))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  if (!conv) return;
  // checkout_token links an order back to the checkout session that
  // produced it — the abandonment nudge checks for this marker before
  // sending, and the attribution stat counts placed orders carrying it.
  const orderRef = {
    kind,
    order_id: String(payload.id ?? payload.order_number ?? ''),
    checkout_token: (payload.checkout_token as string | undefined) ?? null,
    total: total ?? null,
    currency: currency ?? null,
  };
  await systemNote(db, row.workspaceId, conv.id, summary, 'order_event', { extra: { order: orderRef } });

  if (kind === 'refunded') {
    const { created, alert } = await openAlertOnce(db, {
      conversationId: conv.id,
      type: 'custom',
      detail: summary,
    });
    if (created && alert) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId)).limit(1);
      if (agent) await dispatchAlert(db, agent, conv, alert).catch(() => {});
    }
  }
}

/* ── Shopify Billing (AppSubscription) ─────────────────────────────────
 * A bound merchant subscribes to a Janis plan on Shopify's rails instead of
 * Stripe: appSubscriptionCreate → merchant approves on confirmationUrl →
 * app_subscriptions/update webhook flips workspaces.plan + billing_provider.
 * Paid plans only — free/internal never reach Shopify. */

interface ShopBilling {
  subscriptionId?: string;
  plan?: string;
  status?: string;
}

/** The subscription the merchant currently holds (empty when never billed). */
export function shopBilling(row: ShopRow): ShopBilling {
  return ((row.billing ?? {}) as ShopBilling) ?? {};
}

/** Dev stores REQUIRE test:true on app charges; real stores REJECT it — the
 *  only correct value is "is this a development store". Derive it live from
 *  shop.plan so a forgotten global flag can't leak test charges into prod.
 *  Unexplained → true: a charge that moves no money, never a silent real one. */
export async function shopIsDevelopment(db: Db, row: ShopRow): Promise<boolean> {
  if (!row.accessTokenEnc) return false;
  const token = await adminToken(db, row).catch(() => null);
  if (!token) return true; // refresh unreachable → unexplained → dev-side
  const res = await shopifyGraphql(
    row.shop,
    token,
    `{ shop { plan { partnerDevelopment } } }`,
  );
  return (
    (res.data as { shop?: { plan?: { partnerDevelopment?: boolean } } })?.shop?.plan
      ?.partnerDevelopment ?? true
  );
}

export async function startBillingSubscription(
  db: Db,
  row: ShopRow,
  planKey: string,
): Promise<{ confirmationUrl: string; test: boolean }> {
  const plan = PLANS[planKey];
  if (!plan || plan.baseCents <= 0) throw new Error(`not a Shopify-billable plan: ${planKey}`);
  if (!row.accessTokenEnc) throw new Error('shop has no offline token');
  if (!row.workspaceId) throw new Error('shop is not linked to a workspace');
  const token = await adminToken(db, row);
  const test = await shopIsDevelopment(db, row);
  const amount = (plan.baseCents / 100).toFixed(2);
  const res = await shopifyGraphql(
    row.shop,
    token,
    `mutation { appSubscriptionCreate(name: ${JSON.stringify(`Janis ${plan.name}`)}, returnUrl: ${JSON.stringify(`${env.webOrigin}/shopify-app`)}, test: ${test}, lineItems: [{plan: {appRecurringPricingDetails: {price: {amount: ${amount}, currencyCode: USD}, interval: EVERY_30_DAYS}}}]) { confirmationUrl appSubscription { id status } userErrors { field message } } }`,
  );
  const out = (res.data as {
    appSubscriptionCreate?: {
      confirmationUrl?: string;
      appSubscription?: { id: string; status: string };
      userErrors?: { message: string }[];
    };
  })?.appSubscriptionCreate;
  if (out?.userErrors?.length)
    throw new Error(`appSubscriptionCreate: ${out.userErrors.map((e) => e.message).join(', ')}`);
  if (!out?.confirmationUrl || !out.appSubscription?.id)
    throw new Error(`appSubscriptionCreate: no confirmation URL (${res.errors?.[0]?.message ?? 'empty response'})`);
  await db
    .update(shopifyShops)
    .set({
      billing: {
        ...shopBilling(row),
        subscriptionId: out.appSubscription.id,
        plan: planKey,
        status: out.appSubscription.status ?? 'PENDING',
      },
      updatedAt: new Date(),
    })
    .where(eq(shopifyShops.id, row.id));
  return { confirmationUrl: out.confirmationUrl, test };
}

/** checkouts/update — the abandonment signal. One note per checkout on a
 *  matched shopper's thread ("started checkout — N items, $X"); the
 *  proactive nudge and recovery messaging build on this marker. */
async function checkoutNote(
  db: Db,
  row: ShopRow,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!row.agentId || !row.workspaceId) return;
  const token = (payload.token ?? payload.id) as string | undefined;
  const email = (payload.email ??
    payload.contact_email ??
    (payload.customer as { email?: string } | undefined)?.email) as string | undefined;
  if (!token || !email) return;
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, row.workspaceId), eq(contacts.email, email)))
    .limit(1);
  if (!contact) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, contact.id))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  if (!conv) return;
  // One note per checkout — checkouts/update refires on every field change.
  const [dup] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        sql`${messages.payload}->>'checkout' = ${token}`,
      ),
    )
    .limit(1);
  if (dup) return;
  const items = Array.isArray(payload.line_items) ? payload.line_items.length : 0;
  const total = payload.total_price as string | undefined;
  const cur = (payload.currency ?? payload.presentment_currency) as string | undefined;
  const summary = `Shopify: checkout activity — ${items || '?'} item${items === 1 ? '' : 's'}${
    total ? `, ${cur ?? ''} ${total}`.trimEnd() : ''
  } (${email})`;
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: summary,
      payload: { internal: true, event: 'checkout_event', checkout: token },
    })
    .returning();
  bus.publish(row.workspaceId, { type: 'message', data: toMessage(note) });

  // Abandoned-checkout nudge — one delayed job per checkout token (the dup
  // check above guarantees exactly one). At fire time runCheckoutNudge
  // re-verifies the shopper still hasn't ordered before speaking.
  const st = shopSettings(row);
  if (st.nudge !== false && conv.state !== 'human' && conv.state !== 'archived') {
    await enqueueJob(db, {
      workspaceId: row.workspaceId,
      type: 'shopify.checkout_nudge',
      payload: { convId: conv.id, checkoutToken: token, summary },
      runAt: new Date(Date.now() + (st.nudge_after_minutes ?? 30) * 60_000),
    });
  }
}

/** Merchant-tunable shop settings ({nudge, nudge_after_minutes}) — the
 *  abandoned-checkout proactive message. On by default; the embedded app's
 *  Store tab toggle writes these via PATCH /api/shopify/settings. */
export interface ShopSettings {
  nudge?: boolean;
  nudge_after_minutes?: number;
}
export function shopSettings(row: ShopRow): ShopSettings {
  return (row.settings ?? {}) as ShopSettings;
}

/** jobs.ts handler — 'shopify.checkout_nudge'. The checkout that produced
 *  the job sat ~N minutes by fire time: if an orders/create note carrying
 *  the same checkout token landed, the shopper converted and no nudge is
 *  owed. Otherwise the agent writes ONE shopper-visible nudge — the
 *  instruction rides as an internal 'in' turn (visitor-filtered, but the
 *  model reads it) so the normal reply pipeline composes it in-voice. */
export async function runCheckoutNudge(
  db: Db,
  workspaceId: string,
  payload: { convId?: string; checkoutToken?: string; summary?: string },
): Promise<void> {
  const { convId, checkoutToken, summary } = payload;
  if (!convId || !checkoutToken) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv || conv.state === 'human' || conv.state === 'archived') return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1);
  if (!agent?.hosted) return;

  const [converted] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, convId),
        sql`${messages.payload}->>'event' = 'order_event'`,
        sql`${messages.payload}->'order'->>'checkout_token' = ${checkoutToken}`,
      ),
    )
    .limit(1);
  if (converted) return;

  // One nudge per checkout — a retried job must not nag twice.
  const [sent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, convId),
        sql`${messages.payload}->>'event' = 'checkout_nudge'`,
        sql`${messages.payload}->>'checkout' = ${checkoutToken}`,
      ),
    )
    .limit(1);
  if (sent) return;

  const directive =
    `(Janis — not the shopper: they began checkout on the store a while ago ` +
    `(${summary ?? 'items in their cart'}) and haven't placed the order yet. ` +
    `Send ONE short, warm nudge — acknowledge what they were buying if the ` +
    `conversation shows it, and offer help or an answer to whatever held them ` +
    `up. Never invent a discount. Do not mention this note.)`;
  await db.insert(messages).values({
    conversationId: convId,
    direction: 'in',
    text: directive,
    payload: { internal: true, event: 'checkout_nudge', checkout: checkoutToken },
  });
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastMessageDirection: 'in' })
    .where(eq(conversations.id, convId));
  // Best-effort: the nudge marker above is already written, so a transient
  // LLM failure would never re-fire anyway — don't dead-letter the job.
  await runHostedEvent(db, agent, {
    type: 'message.user',
    conversation_id: conv.externalId,
    janis_conversation_id: convId,
    timestamp: new Date().toISOString(),
  }).catch((err) => console.error(`checkout nudge ${convId}:`, err));
}

/** Embedded-app stats: orders attributed to a chat conversation (the
 *  shopper emailed/checkout while a thread existed — the order note lands
 *  on it) plus question/topic mix and open knowledge gaps for the
 *  insights card. 30-day window. */
export async function shopifyStats(
  db: Db,
  row: ShopRow,
  agentConfig: unknown,
): Promise<{
  orders_30d: number;
  revenue_30d: { amount: number; currency: string; orders: number }[];
  top_intents: { label: string; count: number }[];
  open_gaps: number;
}> {
  const empty = { orders_30d: 0, revenue_30d: [], top_intents: [], open_gaps: 0 };
  if (!row.agentId) return empty;
  const rev = (await db.execute(sql`
    select count(*)::int as orders,
           coalesce(sum((m.payload->'order'->>'total')::numeric), 0)::float as amount,
           m.payload->'order'->>'currency' as currency
    from ${messages} m
    inner join ${conversations} c on c.id = m.conversation_id
    where c.agent_id = ${row.agentId}
      and m.payload->>'event' = 'order_event'
      and m.payload->'order'->>'kind' = 'placed'
      and m.created_at > now() - interval '30 days'
    group by 3
    order by 1 desc
  `)) as unknown as { rows?: { orders: number; amount: number; currency: string }[] };
  const revenue = (rev.rows ?? []).filter((r) => r.currency);
  const intents = (await db.execute(sql`
    select intent as label, count(*)::int as count
    from ${conversations}
    where agent_id = ${row.agentId}
      and intent is not null
      and created_at > now() - interval '30 days'
    group by intent
    order by 2 desc
    limit 5
  `)) as unknown as { rows?: { label: string; count: number }[] };
  const cached = readGapsCache(agentConfig);
  const openGaps = cached && gapsCacheFresh(cached)
    ? filterDismissedGaps(cached.gaps, agentConfig).length
    : 0;
  return {
    orders_30d: revenue.reduce((n, r) => n + r.orders, 0),
    revenue_30d: revenue,
    top_intents: intents.rows ?? [],
    open_gaps: openGaps,
  };
}

/** app_subscriptions/update → reconcile workspace plan. ACTIVE flips
 *  billing_provider to 'shopify' + sets the plan the merchant bought;
 *  CANCELLED/DECLINED/EXPIRED drops a shopify-billed workspace back to free
 *  (provider stays 'shopify' — that's still their rail, just unsubscribed). */
async function syncBillingSubscription(
  db: Db,
  row: ShopRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const sub = (payload.app_subscription ?? payload) as { admin_graphql_api_id?: string; name?: string; status?: string };
  const status = sub.status ?? '';
  const prior = shopBilling(row);
  // Name "Janis Pro" → 'pro'; fall back to the plan stored at create time.
  const plan = sub.name?.toLowerCase().replace(/^janis\s+/, '').trim() || prior.plan;
  await db
    .update(shopifyShops)
    .set({
      billing: { ...prior, subscriptionId: sub.admin_graphql_api_id ?? prior.subscriptionId, plan, status },
      updatedAt: new Date(),
    })
    .where(eq(shopifyShops.id, row.id));
  if (!row.workspaceId || !PLANS[plan ?? '']) return;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1);
  if (!ws) return;
  // A stray/legacy sub (created before a re-link to a paid workspace, or an
  // abandoned approval later approved) must not hijack a workspace whose
  // billing lives elsewhere — only free or already-shopify-billed
  // workspaces take the plan flip.
  const shopifyRail = ws.billingProvider === 'shopify' || ws.plan === 'free';
  if (status === 'ACTIVE' && shopifyRail) {
    await db
      .update(workspaces)
      .set({ plan: plan!, billingProvider: 'shopify' })
      .where(eq(workspaces.id, ws.id));
  } else if (['CANCELLED', 'DECLINED', 'EXPIRED', 'FROZEN'].includes(status) && ws.billingProvider === 'shopify') {
    await db.update(workspaces).set({ plan: 'free' }).where(eq(workspaces.id, ws.id));
  }
}

export async function handleShopifyWebhook(
  db: Db,
  shop: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop)).limit(1);
  switch (topic) {
    case 'app/uninstalled':
      await uninstallShop(db, shop);
      return;
    case 'customers/data_request':
      if (row) await customerDataRequest(db, row, payload);
      return;
    case 'customers/redact':
      if (row) await customerRedact(db, row, payload);
      return;
    case 'shop/redact':
      if (row) await shopRedact(db, row);
      return;
    case 'orders/create':
      if (row) await orderEventNote(db, row, payload, 'placed');
      return;
    case 'orders/fulfilled':
      if (row) await orderEventNote(db, row, payload, 'fulfilled');
      return;
    case 'refunds/create':
      if (row) await orderEventNote(db, row, payload, 'refunded');
      return;
    case 'products/create':
    case 'products/update':
    case 'products/delete':
      if (row?.agentId) await bumpCatalogSync(db, row.agentId).catch(() => {});
      return;
    case 'app_subscriptions/update':
      if (row) await syncBillingSubscription(db, row, payload);
      return;
    case 'checkouts/update':
      if (row) await checkoutNote(db, row, payload);
      return;
    default:
      return;
  }
}
