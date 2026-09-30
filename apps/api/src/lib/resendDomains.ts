import { env } from '../env.js';

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
  if (!res.ok) throw new Error(body.message ?? `resend ${res.status}`);
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
