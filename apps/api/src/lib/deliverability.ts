import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { suppressions } from '../db/schema.js';
import { normalizeAddress } from './sendPolicy.js';
import { audit } from './audit.js';
import { env } from '../env.js';

/** Write a suppression — idempotent on (workspace, address, kind). Called by
 *  bounce/complaint webhooks, Twilio status callbacks, and CRM opt-out sync. */
export async function recordSuppression(
  db: Db,
  args: {
    workspaceId: string;
    address: string;
    kind?: 'all' | 'email' | 'phone';
    reason: 'bounce' | 'complaint' | 'dead_number' | 'manual';
    source: string;
  },
): Promise<void> {
  const address = normalizeAddress(args.address);
  if (!address) return;
  await db
    .insert(suppressions)
    .values({
      workspaceId: args.workspaceId,
      address,
      kind: args.kind ?? 'all',
      reason: args.reason,
      source: args.source,
    })
    .onConflictDoNothing();
  await audit(db, {
    workspaceId: args.workspaceId,
    action: 'suppression.add',
    targetType: 'suppression',
    meta: { address, kind: args.kind ?? 'all', reason: args.reason, source: args.source },
  });
}

export interface ChannelReadiness {
  ok: boolean;
  warnings: string[];
}

/** Twilio A2P check lives on messaging.twilio.com (not the api.twilio.com
 *  host twilioApi wraps) — returns true when at least one registered brand
 *  exists on the account the channel's creds belong to. */
async function hasRegisteredBrand(sid: string, token: string): Promise<boolean | null> {
  const res = await fetch('https://messaging.twilio.com/v1/BrandRegistrations?PageSize=1', {
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return (data.data?.length ?? 0) > 0;
}

/** Resend: is the sending domain verified? Returns null when unverifiable. */
async function resendDomainVerified(domain: string): Promise<boolean | null> {
  if (!env.resendApiKey) return null;
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${env.resendApiKey}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as {
    data?: { name?: string; status?: string }[];
  };
  const d = data.data?.find((x) => x.name === domain);
  return d ? d.status === 'verified' : false;
}

/** Can this channel credibly carry a campaign to `audienceSize` recipients?
 *  Warnings block nothing — they're activation-time surface area so a
 *  customer finds out "your Gmail can't send 5k emails" before the blast,
 *  not after. ok=false is reserved for hard blockers. */
export async function channelReadiness(
  channel: { kind: string; credentials?: unknown },
  audienceSize: number,
): Promise<ChannelReadiness> {
  const creds = (channel.credentials ?? {}) as {
    twilio_account_sid?: string;
    twilio_auth_token?: string;
    from_address?: string;
    inbound_address?: string;
  };
  const warnings: string[] = [];

  if (channel.kind === 'sms' || channel.kind === 'whatsapp') {
    if (creds.twilio_account_sid && creds.twilio_auth_token) {
      const branded = await hasRegisteredBrand(creds.twilio_account_sid, creds.twilio_auth_token);
      if (branded === false) {
        warnings.push(
          'No A2P 10DLC brand registered on this Twilio account — bulk US SMS will be filtered or blocked by carriers. Register a brand + campaign in Twilio first.',
        );
      } else if (branded === null) {
        warnings.push("Couldn't verify A2P registration with Twilio — check brand status before sending bulk.");
      }
    } else {
      warnings.push('SMS channel is missing Twilio credentials.');
    }
  }

  if (channel.kind === 'gmail' && audienceSize > 400) {
    warnings.push(
      `Gmail isn't bulk infrastructure — ~500/day consumer, ~2000/day Workspace. Audience is ${audienceSize}; sends past the cap will fail and hurt sender reputation.`,
    );
  }
  if (channel.kind === 'outlook' && audienceSize > 400) {
    warnings.push(
      `Outlook/365 throttles bulk sends (~30/min, daily recipient caps). Audience is ${audienceSize} — expect rate-limit failures.`,
    );
  }
  if (channel.kind === 'email') {
    const domain = (creds.from_address ?? creds.inbound_address ?? '').split('@')[1];
    if (domain) {
      const verified = await resendDomainVerified(domain);
      if (verified === false) {
        warnings.push(`Sending domain ${domain} isn't verified in Resend — sends will fail.`);
      }
      if (domain === env.emailInboundDomain && audienceSize > 500) {
        warnings.push(
          `Sending from the shared ${env.emailInboundDomain} domain — high volume risks the shared reputation; verify a custom domain.`,
        );
      }
    }
  }
  return { ok: true, warnings };
}
