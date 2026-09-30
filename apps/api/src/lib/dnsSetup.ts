import { resolveNs, resolveTxt } from 'node:dns/promises';
import { createSign } from 'node:crypto';
import { env } from '../env.js';
import type { ResendDnsRecord } from './resendDomains.js';

/** Auto-DNS-setup provider detection. Priority:
 *  1. Domain Connect — the DNS provider hosts an "approve these records"
 *     page; no token grant, works on ~25 providers (Cloudflare included).
 *     Requires our template in the public registry (janis.ai/email-domain)
 *     plus a signing keypair — dormant until DC_PRIVATE_KEY is set.
 *  2. Cloudflare OAuth — persistent zone.read+dns.write grant.
 *  3. Manual — the records table.
 */

export type DnsSetupMode =
  | { mode: 'domainconnect'; url: string }
  | { mode: 'cloudflare' }
  | { mode: 'manual' };

const apexOf = (domain: string) => {
  const l = domain.split('.');
  return l.length > 2 ? l.slice(-2).join('.') : domain;
};

async function dnsQuery(kind: 'txt' | 'ns', name: string): Promise<string[]> {
  try {
    const out = kind === 'txt' ? await resolveTxt(name) : await resolveNs(name);
    return out.flat();
  } catch {
    return [];
  }
}

interface DcSettings {
  urlSyncUX?: string;
  urlAPI?: string;
  providerName?: string;
}

/** Domain Connect discovery: _domainconnect.<apex> TXT names the provider's
 *  DC API base; GET <api>/v2/<domain>/settings returns the sync-UX host. */
async function domainConnectSettings(domain: string): Promise<DcSettings | null> {
  const apex = apexOf(domain);
  const hosts = await dnsQuery('txt', `_domainconnect.${apex}`);
  const apiBase = hosts[0];
  if (!apiBase) return null;
  const res = await fetch(`https://${apiBase}/v2/${domain}/settings`, {
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as DcSettings | null;
}

/** Sign the DC apply query per spec: RSA-SHA256 over the sorted params,
 *  key= selects the pubkey TXT under syncPubKeyDomain (janis.ai). */
function dcSignedApplyUrl(syncUx: string, params: Record<string, string>): string {
  const ordered = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  const sig = createSign('RSA-SHA256').update(ordered).sign(env.dcPrivateKey, 'base64url');
  return `${syncUx}/v2/domainTemplates/providers/janis.ai/services/email-domain/apply?${ordered}&sig=${sig}`;
}

export async function detectDnsSetup(
  domain: string,
  records: ResendDnsRecord[],
): Promise<DnsSetupMode> {
  // Domain Connect — only when the provider answers discovery AND our
  // template + signing key exist (registry PR pending until then).
  if (env.dcPrivateKey) {
    const s = await domainConnectSettings(domain);
    if (s?.urlSyncUX) {
      const apex = apexOf(domain);
      const params: Record<string, string> = { domain: apex, key: '_dc' };
      const hostPrefix = domain === apex ? '' : domain.slice(0, -(apex.length + 1));
      if (hostPrefix) params.host = hostPrefix;
      // Record values flow in as template variables — the registry template
      // maps %r1type%/%r1name%/%r1value% style vars onto real records.
      records.forEach((r, i) => {
        params[`r${i}type`] = r.type;
        params[`r${i}name`] = r.name;
        params[`r${i}value`] = r.value;
        if (r.priority != null) params[`r${i}priority`] = String(r.priority);
      });
      return { mode: 'domainconnect', url: dcSignedApplyUrl(s.urlSyncUX, params) };
    }
  }
  // Cloudflare OAuth — NS check (covers zones whose DC discovery failed too).
  const ns = await dnsQuery('ns', apexOf(domain));
  if (ns.some((n) => n.endsWith('.ns.cloudflare.com'))) return { mode: 'cloudflare' };
  return { mode: 'manual' };
}
