import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agentSecrets, agents, channels, contacts, shopifyShops } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { audit } from './audit.js';
import { invalidateChannelCache } from './channels.js';
import { purgeContactData } from './contacts.js';
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
/** Agent-secret names the link mirrors — same names the PAT template uses,
 *  so tool defs are connection-agnostic. */
const MIRROR_SECRETS = ['SHOPIFY_SHOP', 'SHOPIFY_TOKEN'] as const;

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

/* ── Token exchange + Admin API calls ───────────────────────────────── */

interface OfflineToken {
  access_token: string;
  scope: string;
}

/** Session token → offline Admin API token (managed install). */
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
  return { access_token: data.access_token, scope: data.scope ?? '' };
}

async function shopifyGraphql(
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

/** app/uninstalled must be API-registered (the mandatory GDPR topics are
 *  declared in app config instead). Idempotent — checks before creating.
 *  Best-effort: a failure logs and the install still succeeds; the session
 *  endpoint retries on the next embedded load anyway. */
async function registerWebhooks(shop: string, token: string): Promise<void> {
  const cbUrl = `${env.apiOrigin}/shopify/webhooks`;
  const existing = await shopifyGraphql(
    shop,
    token,
    `{ webhookSubscriptions(first: 25) { nodes { endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } topic } } }`,
  );
  const nodes =
    (existing.data as { webhookSubscriptions?: { nodes?: { topic: string; endpoint?: { callbackUrl?: string } }[] } })
      ?.webhookSubscriptions?.nodes ?? [];
  const have = nodes.some(
    (n) => n.topic === 'APP_UNINSTALLED' && n.endpoint?.callbackUrl === cbUrl,
  );
  if (have) return;
  const created = await shopifyGraphql(
    shop,
    token,
    `mutation { webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: {callbackUrl: ${JSON.stringify(cbUrl)}, format: JSON}) { webhookSubscription { id } userErrors { field message } } }`,
  );
  const errs =
    (created.data as { webhookSubscriptionCreate?: { userErrors?: { message: string }[] } })
      ?.webhookSubscriptionCreate?.userErrors ?? [];
  if (errs.length) console.error(`shopify webhook register ${shop}:`, errs.map((e) => e.message).join(', '));
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
    // self-heals here; upserts are cheap.
    await mirrorSecrets(db, row.agentId, row.workspaceId, shop, decryptSecret(row.accessTokenEnc));
  }
  return row;
}

/** Agent-secret upsert for the SHOPIFY_* mirror — encrypted at rest like
 *  every other secret. */
async function setAgentSecret(
  db: Db,
  agentId: string,
  workspaceId: string,
  name: string,
  value: string,
): Promise<void> {
  await db
    .insert(agentSecrets)
    .values({ workspaceId, agentId, name, valueEnc: encryptSecret(value) })
    .onConflictDoUpdate({
      target: [agentSecrets.agentId, agentSecrets.name],
      set: { valueEnc: encryptSecret(value), updatedAt: new Date() },
    });
}

async function mirrorSecrets(
  db: Db,
  agentId: string,
  workspaceId: string,
  shop: string,
  token: string,
): Promise<void> {
  await setAgentSecret(db, agentId, workspaceId, 'SHOPIFY_SHOP', shop);
  await setAgentSecret(db, agentId, workspaceId, 'SHOPIFY_TOKEN', token);
}

async function clearMirroredSecrets(db: Db, agentId: string): Promise<void> {
  await db
    .delete(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), inArray(agentSecrets.name, [...MIRROR_SECRETS])));
}

/** Console link — bind the shop to a workspace agent and hand the agent
 *  the shop credentials as secrets. */
export async function bindShop(
  db: Db,
  row: ShopRow,
  binding: { workspaceId: string; agentId: string },
): Promise<void> {
  const token = row.accessTokenEnc ? decryptSecret(row.accessTokenEnc) : '';
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
    .set({ accessTokenEnc: null, scopes: '', state: 'uninstalled', updatedAt: new Date() })
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
    default:
      return;
  }
}
