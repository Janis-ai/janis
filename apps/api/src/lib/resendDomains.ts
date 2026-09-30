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
