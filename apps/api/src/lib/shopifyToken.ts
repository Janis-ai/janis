import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agentSecrets, shopifyShops } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secrets.js';

/**
 * Refresh-aware access to a shop's offline Admin API token.
 *
 * Shopify's new public apps get EXPIRING offline tokens — the token
 * exchange is sent `expiring: 1` and answers with a 1h access token plus
 * a 90d rotating refresh_token (each refresh may return a NEW refresh
 * token; persist it or the next refresh fails). adminToken() is the only
 * correct way to read a shop's credential: it returns the stored token
 * while it still has >60s of life and refreshes through Shopify
 * otherwise — persisting both halves and re-mirroring the bound agent's
 * SHOPIFY_TOKEN secret so shopify_* tools keep working between merchant
 * admin loads. Rows with no token_expires_at hold legacy non-expiring
 * tokens (pre-expiring installs) — returned as-is, like before.
 *
 * Kept dependency-light (schema + secrets + env only) so every tool-exec
 * path can freshen without pulling in the full install/billing module.
 */

type ShopRow = typeof shopifyShops.$inferSelect;

/** Agent-secret names the link mirrors — same names the PAT template uses,
 *  so tool defs are connection-agnostic. */
export const MIRROR_SECRETS = ['SHOPIFY_SHOP', 'SHOPIFY_TOKEN'] as const;

// Refresh 60s before real expiry — a just-issued request can't die mid-flight.
const REFRESH_MARGIN_MS = 60_000;

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

export async function mirrorSecrets(
  db: Db,
  agentId: string,
  workspaceId: string,
  shop: string,
  token: string,
): Promise<void> {
  await setAgentSecret(db, agentId, workspaceId, 'SHOPIFY_SHOP', shop);
  await setAgentSecret(db, agentId, workspaceId, 'SHOPIFY_TOKEN', token);
}

export async function clearMirroredSecrets(db: Db, agentId: string): Promise<void> {
  await db
    .delete(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), inArray(agentSecrets.name, [...MIRROR_SECRETS])));
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The refresh_token grant — same endpoint as the exchange, form-encoded
 *  per Shopify's docs. May rotate the refresh token; callers persist the
 *  pair atomically. */
async function refreshOfflineToken(shop: string, refreshToken: string): Promise<RefreshResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.shopifyAppApiKey ?? '',
      client_secret: env.shopifyAppApiSecret ?? '',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as RefreshResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? `shopify token refresh failed (${res.status})`,
    );
  }
  return data;
}

/** A live Admin API token for a shop row — decrypts the stored token when
 *  it's non-expiring or still valid; refreshes, persists, and re-mirrors
 *  when expired. Throws when the shop has no token or the refresh fails
 *  (a failed refresh self-heals on the next embedded load, which always
 *  re-exchanges the session token). */
export async function adminToken(db: Db, row: ShopRow): Promise<string> {
  if (!row.accessTokenEnc) throw new Error(`shop ${row.shop} has no offline token`);
  // Non-expiring (legacy) or still-valid token — the common, cheap path.
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return decryptSecret(row.accessTokenEnc);
  }
  if (!row.refreshTokenEnc) {
    throw new Error(`shop ${row.shop}: expired token with no refresh token — merchant must reopen the app`);
  }
  const refreshed = await refreshOfflineToken(row.shop, decryptSecret(row.refreshTokenEnc));
  const updates: Partial<ShopRow> = {
    accessTokenEnc: encryptSecret(refreshed.access_token),
    updatedAt: new Date(),
  };
  // Refresh tokens rotate — always persist the replacement when Shopify
  // sends one; the old one is dead from this point.
  if (refreshed.refresh_token) updates.refreshTokenEnc = encryptSecret(refreshed.refresh_token);
  updates.tokenExpiresAt =
    refreshed.expires_in && refreshed.expires_in > 0
      ? new Date(Date.now() + refreshed.expires_in * 1000)
      : null;
  await db.update(shopifyShops).set(updates).where(eq(shopifyShops.id, row.id));
  // The mirrored secret tools resolve is a copy — re-mirror on every
  // refresh so a stale SHOPIFY_TOKEN can't strand chat runs mid-hour.
  if (row.state === 'linked' && row.agentId && row.workspaceId) {
    await mirrorSecrets(db, row.agentId, row.workspaceId, row.shop, refreshed.access_token);
  }
  return refreshed.access_token;
}

/** Pre-tool-run freshness seam: if the agent's linked shop holds an
 *  expiring token past its margin, refresh + re-mirror so the next
 *  loadSecretsMap() reads a live SHOPIFY_TOKEN. Never throws — a failed
 *  refresh must not take the agent run down with it (the tools surface
 *  Shopify's error instead). */
export async function freshShopifyToken(db: Db, agentId: string): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(shopifyShops)
      .where(and(eq(shopifyShops.agentId, agentId), eq(shopifyShops.state, 'linked')))
      .orderBy(desc(shopifyShops.updatedAt)) // most recent wins if rebound across shops
      .limit(1);
    if (!row?.tokenExpiresAt || row.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return;
    await adminToken(db, row);
  } catch (err) {
    console.error(`shopify token freshness agent ${agentId}:`, err);
  }
}
