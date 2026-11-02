import { createHmac } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { env, requestOrigin } from '../env.js';
import type { Db } from '../db/client.js';
import type { SessionEnv } from '../middleware/sessionAuth.js';
import { agentRoleFor, isAdminRole } from './access.js';
import {
  cfAuthorizeUrl,
  cfExchangeCode,
  cfRefresh,
  cloudflareSetupRecords,
  createOrAdoptResendDomain,
  deleteResendDomain,
  getResendDomain,
  verifyResendDomain,
  type ResendDnsRecord,
} from './resendDomains.js';
import { detectDnsSetup } from './dnsSetup.js';

/**
 * Custom sending domain (Resend-verified) — the route family an email-domain
 * owner mounts: an 'email' channel or an agent's config.email_sending (the
 * no-channel-needed sender for verification codes and other agent mail).
 * The client registers e.g. mail.acme.com on our Resend account, we surface
 * the DNS records, verification flips status. Mail keeps routing replies via
 * the owner's own reply path — sending-side records only.
 */

/** The stored credential bag a domain owner carries — the whole channel
 *  credentials object for an email channel, config.email_sending for an
 *  agent. Handlers merge into it; save() persists the merged bag. */
export interface EmailDomainBag {
  email_domain?: string;
  email_domain_id?: string;
  email_domain_status?: string;
  email_domain_checked_at?: string;
  email_domain_records?: ResendDnsRecord[];
  cf_refresh_token?: string;
  from_name?: string;
  from_address?: string;
}

export interface EmailDomainOwner {
  /** channels.id or agents.id — the route's :id param. */
  id: string;
  /** The agent the admin-role check scopes to (channel.agentId / the agent). */
  agentId: string;
  bag: EmailDomainBag;
}

type LoadResult = EmailDomainOwner | { error: string } | null;

/** After the Cloudflare OAuth code exchange: push the bag's pending records
 *  (when a domain is registered), re-check verification, and return the
 *  merged bag to persist. Shared by every owner kind's cf-callback. */
export async function cfDomainFinish(
  bag: EmailDomainBag,
  code: string,
  redirectUri: string,
): Promise<{ next: EmailDomainBag; pushed: string }> {
  const tokens = await cfExchangeCode(code, redirectUri);
  const next = { ...bag, cf_refresh_token: tokens.refresh_token ?? bag.cf_refresh_token };
  let pushed = '';
  if (bag.email_domain && bag.email_domain_records?.length) {
    const out = await cloudflareSetupRecords(bag.email_domain, bag.email_domain_records, tokens.access_token);
    if (bag.email_domain_id) {
      await verifyResendDomain(bag.email_domain_id).catch(() => {});
      const d = await getResendDomain(bag.email_domain_id);
      next.email_domain_status = d.status ?? bag.email_domain_status;
      if (d.records?.length) next.email_domain_records = d.records;
    }
    pushed = ` — ${out.created} record${out.created === 1 ? '' : 's'} created`;
  }
  return { next, pushed };
}

export function mountEmailDomainRoutes(
  app: Hono<SessionEnv>,
  db: Db,
  opts: {
    /** Workspace-scoped owner lookup — null → 404, {error} → 400. */
    load: (workspaceId: string, id: string) => Promise<LoadResult>;
    save: (owner: EmailDomainOwner, bag: EmailDomainBag) => Promise<void>;
    /** State key binding the Cloudflare OAuth round-trip to this owner kind
     *  ('ch' channel | 'ag' agent) — the cf-callback reads it back. */
    stateKey: 'ch' | 'ag';
    /** Email channels may send as their inbound-domain reply address; an
     *  agent-level sender can only use the verified custom domain. */
    inboundFromAllowed: boolean;
    /** After a domain delete — receives the PRE-delete bag. Agents use it to
     *  strip the same domain off email channels: one management spot. */
    onDelete?: (owner: EmailDomainOwner, removed: EmailDomainBag) => Promise<void>;
  },
) {
  const admin = async (c: Context<SessionEnv>, agentId: string) =>
    isAdminRole(
      await agentRoleFor(
        db,
        c.get('user').id,
        c.get('role'),
        c.get('agentScope'),
        agentId,
        c.get('workspaceId'),
      ),
    );

  /** load → 404/400, then admin → 403. The common gate every route shares. */
  const ownerFor = async (
    c: Context<SessionEnv>,
  ): Promise<{ owner?: EmailDomainOwner; res?: Response }> => {
    const o = await opts.load(c.get('workspaceId'), c.req.param('id')!);
    if (!o) return { res: c.json({ error: 'not found' }, 404) };
    if ('error' in o) return { res: c.json({ error: o.error }, 400) };
    if (!(await admin(c, o.agentId))) return { res: c.json({ error: 'admin required' }, 403) };
    return { owner: o };
  };

  const cfRedirectUri = (c: Context) => `${requestOrigin(c)}/channels/email-domain/cf-callback`;
  const cfState = (owner: EmailDomainOwner, workspaceId: string) => {
    const b64 = Buffer.from(
      JSON.stringify({ [opts.stateKey]: owner.id, w: workspaceId, x: Date.now() + 600_000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', env.sessionSecret).update(b64).digest('base64url');
    return `cf.${b64}.${sig}`;
  };

  app.post(
    '/:id/email-domain',
    zValidator('json', z.object({ domain: z.string().min(4).max(200) })),
    async (c) => {
      const { owner, res } = await ownerFor(c);
      if (!owner) return res!;
      const domain = c.req
        .valid('json')
        .domain.trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/?#].*$/, '');
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) || domain.endsWith(env.emailInboundDomain))
        return c.json({ error: 'enter a domain you own — e.g. mail.acme.com' }, 400);
      if (!env.resendCustomDomains)
        return c.json({ error: 'custom sending domains are not available on this deployment' }, 400);
      const bag = owner.bag;
      let d;
      try {
        // idempotent — re-registering an existing domain adopts it
        d = await createOrAdoptResendDomain(domain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Resend's raw "your plan" message reads as the customer's plan —
        // it's actually the platform account's domain quota.
        if (/domain limit/i.test(msg))
          return c.json({ error: 'custom sending domains are temporarily unavailable — try again later' }, 503);
        return c.json({ error: `resend: ${msg}` }, 502);
      }
      const next = {
        ...bag,
        email_domain: domain,
        email_domain_id: d.id,
        email_domain_status: d.status ?? 'pending',
        email_domain_records: d.records ?? [],
      };
      await opts.save(owner, next);
      return c.json({ email_domain: domain, status: next.email_domain_status, records: next.email_domain_records });
    },
  );

  app.post('/:id/email-domain/verify', async (c) => {
    const { owner, res } = await ownerFor(c);
    if (!owner) return res!;
    const bag = owner.bag;
    if (!bag.email_domain_id) return c.json({ error: 'no domain registered' }, 400);
    try {
      // ask Resend to re-check; a not-yet-propagated domain can error — the
      // fresh GET below is the source of truth either way
      await verifyResendDomain(bag.email_domain_id).catch(() => {});
      const d = await getResendDomain(bag.email_domain_id);
      const next = {
        ...bag,
        email_domain_status: d.status ?? bag.email_domain_status,
        ...(d.records?.length ? { email_domain_records: d.records } : {}),
      };
      await opts.save(owner, next);
      return c.json({ status: next.email_domain_status, records: next.email_domain_records ?? bag.email_domain_records ?? [] });
    } catch (e) {
      return c.json({ error: `resend: ${e instanceof Error ? e.message : e}` }, 502);
    }
  });

  // Cloudflare OAuth — one-click DNS setup. State is HMAC-signed and binds
  // the consent redirect back to this owner (same scheme as Slack).
  app.post('/:id/email-domain/cf-connect', async (c) => {
    if (!env.cfOauthClientId) return c.json({ error: 'cloudflare oauth not configured' }, 503);
    const { owner, res } = await ownerFor(c);
    if (!owner) return res!;
    return c.json({ url: cfAuthorizeUrl(cfRedirectUri(c), cfState(owner, c.get('workspaceId'))) });
  });

  // Best-path DNS setup: Domain Connect → Cloudflare OAuth → manual. The UI
  // calls this and navigates to whatever URL comes back (or shows records).
  app.post('/:id/email-domain/dns-setup', async (c) => {
    const { owner, res } = await ownerFor(c);
    if (!owner) return res!;
    const bag = owner.bag;
    if (!bag.email_domain || !bag.email_domain_records?.length)
      return c.json({ error: 'register a domain first' }, 400);
    const mode = await detectDnsSetup(bag.email_domain, bag.email_domain_records);
    if (mode.mode === 'cloudflare') {
      if (!env.cfOauthClientId) return c.json({ mode: 'manual' });
      return c.json({
        mode: 'cloudflare',
        url: cfAuthorizeUrl(cfRedirectUri(c), cfState(owner, c.get('workspaceId'))),
      });
    }
    return c.json(mode);
  });

  // Push the DNS records into Cloudflare on the client's behalf — an OAuth
  // connection if one exists, else a one-shot API token (never stored).
  // Skips records that already exist.
  app.post(
    '/:id/email-domain/cf-setup',
    zValidator('json', z.object({ api_token: z.string().min(20).max(200).optional() })),
    async (c) => {
      const { owner, res } = await ownerFor(c);
      if (!owner) return res!;
      const bag = owner.bag;
      if (!bag.email_domain || !bag.email_domain_records?.length)
        return c.json({ error: 'register a domain first' }, 400);
      try {
        let token = c.req.valid('json').api_token;
        if (!token) {
          if (!bag.cf_refresh_token)
            return c.json({ error: 'connect Cloudflare or paste an API token' }, 400);
          token = (await cfRefresh(bag.cf_refresh_token)).access_token;
        }
        const out = await cloudflareSetupRecords(bag.email_domain, bag.email_domain_records, token);
        await verifyResendDomain(bag.email_domain_id!).catch(() => {});
        const d = await getResendDomain(bag.email_domain_id!);
        const next = {
          ...bag,
          email_domain_status: d.status ?? bag.email_domain_status,
          ...(d.records?.length ? { email_domain_records: d.records } : {}),
        };
        await opts.save(owner, next);
        return c.json({ ...out, status: next.email_domain_status, records: next.email_domain_records });
      } catch (e) {
        return c.json({ error: `cloudflare: ${e instanceof Error ? e.message : e}` }, 502);
      }
    },
  );

  // The send-as identity — display name + the address verification codes and
  // replies send From. Addresses are limited to what we can actually send
  // as: the verified custom domain, plus the shared inbound domain where
  // the owner has a reply address (channels only).
  app.patch(
    '/:id/email-sending',
    zValidator(
      'json',
      z.object({
        from_name: z.string().max(120).optional(),
        from_address: z.string().email().max(200).or(z.literal('')).optional(),
      }),
    ),
    async (c) => {
      const { owner, res } = await ownerFor(c);
      if (!owner) return res!;
      const body = c.req.valid('json');
      const next = { ...owner.bag };
      if (body.from_name !== undefined) {
        const name = body.from_name.trim();
        if (name) next.from_name = name;
        else delete next.from_name;
      }
      if (body.from_address !== undefined) {
        const addr = body.from_address.trim().toLowerCase();
        if (!addr) delete next.from_address;
        else {
          const allowed =
            (opts.inboundFromAllowed &&
              addr.endsWith(`@${env.emailInboundDomain}`)) ||
            (next.email_domain &&
              next.email_domain_status === 'verified' &&
              addr.endsWith(`@${next.email_domain}`));
          if (!allowed) {
            return c.json(
              {
                error: opts.inboundFromAllowed
                  ? `from_address must be on ${env.emailInboundDomain} or a domain verified under Custom sending domain`
                  : 'from_address must be on a domain verified under Custom sending domain',
              },
              400,
            );
          }
          next.from_address = addr;
        }
      }
      await opts.save(owner, next);
      return c.json({ ok: true });
    },
  );

  app.delete('/:id/email-domain', async (c) => {
    const { owner, res } = await ownerFor(c);
    if (!owner) return res!;
    const bag = owner.bag;
    if (bag.email_domain_id) void deleteResendDomain(bag.email_domain_id).catch(() => {});
    const next = { ...bag };
    delete next.email_domain;
    delete next.email_domain_id;
    delete next.email_domain_status;
    delete next.email_domain_records;
    // a branded From on the removed domain can no longer send
    if (next.from_address && bag.email_domain && next.from_address.endsWith(`@${bag.email_domain}`))
      delete next.from_address;
    await opts.save(owner, next);
    await opts.onDelete?.(owner, bag);
    return c.json({ ok: true });
  });
}
