import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import {
  agents,
  channels,
  contacts,
  conversations,
  messages,
  shopifyShops,
  workspaces,
} from '../db/schema.js';
import { PLANS } from './plans.js';
import { encryptSecret } from './secrets.js';
import { adminToken, clearMirroredSecrets, mirrorSecrets } from './shopifyToken.js';
import { audit } from './audit.js';
import { dispatchAlert, openAlertOnce } from './alerts.js';
import { invalidateChannelCache } from './channels.js';
import { purgeContactData } from './contacts.js';
import { bumpCatalogSync, ensureShopifyKnowledge } from './shopifySync.js';
import { systemNote } from './systemNote.js';
import { bus } from './bus.js';
import { toMessage } from './serializers.js';
import { TOOL_TEMPLATES } from './toolTemplates.js';

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
const SHOPIFY_API_VERSION = '2026-10';
const LINK_CODE_TTL_MS = 30 * 60 * 1000;

export function shopifyAppConfigured(): boolean {
  return Boolean(env.shopifyAppApiKey && env.shopifyAppApiSecret);
}

/* ── Session-token JWT (App Bridge idToken) ─────────────────────────── */

/** Verify an App Bridge session token — HS256 signed with the app secret,
 *  aud = api key, iss/dest pin it to one *.myshopify.com shop. Returns the
 *  shop domain or null. */
export function verifySessionToken(token: string): { shop: string } | null {
  const [h, p, s] = (token ?? '').split('.');
  if (!h || !p || !s || !env.shopifyAppApiSecret) return null;
  const expected = createHmac('sha256', env.shopifyAppApiSecret)
    .update(`${h}.${p}`)
    .digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

  let claims: {
    iss?: string;
    dest?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
  };
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return null;
  }
  const now = Date.now() / 1000;
  if (!claims.exp || claims.exp < now - 30) return null; // 30s clock skew
  if (claims.nbf && claims.nbf > now + 30) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  if (aud !== env.shopifyAppApiKey) return null;

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
  if (!shop.endsWith('.myshopify.com') || host(claims.iss) !== shop) return null;
  return { shop };
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

export function signLinkCode(shopId: string): string {
  const body = Buffer.from(JSON.stringify({ s: shopId, x: Date.now() + LINK_CODE_TTL_MS })).toString(
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
  await systemNote(db, row.workspaceId, conv.id, summary, 'order_event');

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
  if (status === 'ACTIVE') {
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
