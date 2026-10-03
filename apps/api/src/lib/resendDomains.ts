import { and, eq, sql } from 'drizzle-orm';
import { env } from '../env.js';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import { invalidateChannelCache, type ChannelCredentials } from './channels.js';

/** Resend domain management — client-branded sending. A channel registers
 *  its sending domain (e.g. mail.acme.com), we surface the DNS records,
 *  and the client verifies it; replies still route via Reply-To to the
 *  channel's inbound_address, so no inbound MX setup is needed. */

export interface ResendDnsRecord {
  record?: string; // 'SPF' | 'MX' | 'DKIM' | 'DMARC' | …
  name: string;
  type: string; // CNAME | MX | TXT
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status?: string; // not_started | pending | verified | failed
  region?: string;
  records?: ResendDnsRecord[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.resendApiKey) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
  if (!res.ok) {
    const err = new Error(body.message ?? `resend ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export const createResendDomain = (name: string) =>
  req<ResendDomain>('/domains', { method: 'POST', body: JSON.stringify({ name }) });
export const getResendDomain = (id: string) => req<ResendDomain>(`/domains/${id}`);
export const verifyResendDomain = (id: string) =>
  req<ResendDomain>(`/domains/${id}/verify`, { method: 'POST' });
export const deleteResendDomain = (id: string) => req(`/domains/${id}`, { method: 'DELETE' });

export async function listResendDomains(): Promise<ResendDomain[]> {
  const out = await req<{ data?: ResendDomain[] }>('/domains');
  return out.data ?? [];
}

/** Adopt an existing domain (register is idempotent) or create it. */
export async function createOrAdoptResendDomain(name: string): Promise<ResendDomain> {
  try {
    return await createResendDomain(name);
  } catch (err) {
    if (!/already/i.test(String(err))) throw err;
    const match = (await listResendDomains()).find((d) => d.name === name);
    if (!match) throw err;
    return getResendDomain(match.id);
  }
}

/** Push the domain's DNS records into Cloudflare with a one-shot user token.
 *  Token is never stored. Returns created/skipped counts. */
export async function cloudflareSetupRecords(
  domain: string,
  records: ResendDnsRecord[],
  token: string,
): Promise<{ created: number; skipped: number; zone: string }> {
  const labels = domain.split('.');
  if (labels.length < 2) throw new Error('invalid domain');
  const cf = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      result?: unknown;
      errors?: { message?: string }[];
    };
    if (!res.ok) throw new Error(body.errors?.[0]?.message ?? `cloudflare ${res.status}`);
    return body as T;
  };
  // Find the zone containing the domain — walk up labels (mail.acme.com → acme.com).
  let zoneId = '', zoneName = '';
  for (let i = 0; i < labels.length - 1 && !zoneId; i++) {
    const cand = labels.slice(i).join('.');
    const out = await cf<{ result?: { id: string; name: string }[] }>(
      `/zones?name=${encodeURIComponent(cand)}`,
    );
    const zone = out.result?.[0];
    if (zone) {
      zoneId = zone.id;
      zoneName = zone.name;
    }
  }
  if (!zoneId) throw new Error(`no Cloudflare zone found for ${domain} — is the domain on Cloudflare?`);
  let created = 0, skipped = 0;
  for (const r of records) {
    const fqdn =
      r.name === '@' || r.name === zoneName
        ? zoneName
        : r.name.endsWith(`.${zoneName}`) || r.name === domain
          ? r.name
          : `${r.name}.${zoneName}`;
    const exists = await cf<{ result?: unknown[] }>(
      `/zones/${zoneId}/dns_records?type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(fqdn)}`,
    );
    if (exists.result?.length) {
      skipped++;
      continue;
    }
    await cf(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: r.type,
        name: fqdn,
        content: r.value,
        ttl: 1,
        proxied: false,
        ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}),
      }),
    });
    created++;
  }
  return { created, skipped, zone: zoneName };
}

/** Cloudflare OAuth — one-click DNS setup. The client consents on CF's
 *  screen; we exchange the code and keep the refresh token so later record
 *  changes need no re-consent. */
export const CF_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/authorize';
const CF_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CF_SCOPES = 'zone.read dns.write';

export function cfAuthorizeUrl(redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env.cfOauthClientId,
    redirect_uri: redirectUri,
    scope: CF_SCOPES,
    state,
  });
  return `${CF_AUTHORIZE_URL}?${p}`;
}

interface CfTokens {
  access_token: string;
  refresh_token?: string;
}

async function cfToken(body: Record<string, string>): Promise<CfTokens> {
  const res = await fetch(CF_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.cfOauthClientId,
      client_secret: env.cfOauthClientSecret,
      ...body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = (await res.json().catch(() => ({}))) as CfTokens & { error?: string; error_description?: string };
  if (!res.ok || !out.access_token)
    throw new Error(out.error_description ?? out.error ?? `token exchange ${res.status}`);
  return out;
}

export const cfExchangeCode = (code: string, redirectUri: string) =>
  cfToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const cfRefresh = (refreshToken: string) =>
  cfToken({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Stored credential keys this manages — the sweep stamps checked_at so a
 *  failing Resend call doesn't turn into a fetch-per-tick. */
const EMAIL_DOMAIN_CHECK_MS = 10 * 60_000;
const REFRESH_STATUSES = new Set(['not_started', 'pending', 'temporary_failure', 'failed']);

/** Re-ask Resend for one channel's domain state and merge it into creds.
 *  verify first — Resend only rescans DNS on demand — then the GET is the
 *  source of truth for status + per-record state. A 404 means the domain
 *  was deleted on Resend's side; the stored claim is dead → 'failed'. */
export async function refreshEmailDomainStatus(
  db: Db,
  channel: { id: string; credentials: unknown },
): Promise<boolean> {
  const creds = (channel.credentials ?? {}) as ChannelCredentials;
  if (!creds.email_domain_id) return false;
  const next = { ...creds, email_domain_checked_at: new Date().toISOString() };
  try {
    await verifyResendDomain(creds.email_domain_id).catch(() => {});
    const d = await getResendDomain(creds.email_domain_id);
    next.email_domain_status = d.status ?? creds.email_domain_status;
    if (d.records?.length) next.email_domain_records = d.records;
  } catch (e) {
    if ((e as { status?: number }).status === 404) next.email_domain_status = 'failed';
    // other errors: only checked_at moves — throttle, keep last known status
  }
  await db.update(channels).set({ credentials: next }).where(eq(channels.id, channel.id));
  invalidateChannelCache();
  return next.email_domain_status !== creds.email_domain_status;
}

/** Sweep entry — called under the leader lock each tick. Channels whose
 *  stored domain status is non-terminal and hasn't been re-checked in
 *  EMAIL_DOMAIN_CHECK_MS get refreshed; verified channels cost nothing
 *  (no rows selected). Bounded at 10 per tick — domains are rare. */
export async function sweepEmailDomainStatus(db: Db): Promise<number> {
  if (!env.resendApiKey) return 0;
  const rows = await db
    .select({ id: channels.id, credentials: channels.credentials })
    .from(channels)
    .where(
      and(
        eq(channels.kind, 'email'),
        sql`${channels.credentials}->>'email_domain_id' is not null`,
        sql`${channels.credentials}->>'email_domain_status' <> 'verified'`,
        sql`coalesce(${channels.credentials}->>'email_domain_checked_at', '1970-01-01')
            < ${new Date(Date.now() - EMAIL_DOMAIN_CHECK_MS).toISOString()}`,
      ),
    )
    .limit(10);
  let changed = 0;
  for (const row of rows) {
    const creds = (row.credentials ?? {}) as ChannelCredentials;
    if (!REFRESH_STATUSES.has(creds.email_domain_status ?? 'pending')) continue;
    try {
      if (await refreshEmailDomainStatus(db, row)) changed++;
    } catch {
      // a single bad row shouldn't stall the sweep
    }
  }
  return changed;
}
