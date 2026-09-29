import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channels } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import type { ChannelCredentials } from '../lib/channels.js';

// Read inbox + send on the user's behalf + identity — nothing more.
const SCOPES = 'offline_access Mail.Read Mail.Send User.Read';
const STATE_TTL_MS = 15 * 60 * 1000;
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

interface Intent {
  w: string;
  a: string;
  n?: string;
  l?: boolean;
  x: number;
}

function signIntent(intent: Intent): string {
  const body = Buffer.from(JSON.stringify(intent)).toString('base64url');
  const sig = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyIntent(token: string): Intent | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const i = JSON.parse(Buffer.from(body, 'base64url').toString()) as Intent;
    return i.w && i.a && i.x > Date.now() ? i : null;
  } catch {
    return null;
  }
}

function consentUrl(state: string): string {
  const url = new URL(`https://login.microsoftonline.com/${env.msTenant || 'common'}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.msClientId);
  url.searchParams.set('redirect_uri', env.msRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);
  return url.toString();
}

async function validateAgent(db: Db, workspaceId: string, agentId: string): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(agent);
}

const msConfigured = () => Boolean(env.msClientId && env.msClientSecret);

/** Console endpoints mounted at /api/outlook — session auth + admin. */
export function outlookApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', (c) => c.json({ configured: msConfigured() }));

  app.get('/connect', adminOnly, async (c) => {
    if (!msConfigured()) {
      return c.json({ error: 'Microsoft OAuth not configured (MS_CLIENT_ID/SECRET)' }, 400);
    }
    const agentId = c.req.query('agent_id') ?? '';
    if (!(await validateAgent(db, c.get('workspaceId'), agentId))) {
      return c.json({ error: 'pick the agent this mailbox should answer for' }, 400);
    }
    const state = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      n: c.req.query('name') || undefined,
      x: Date.now() + STATE_TTL_MS,
    });
    return c.redirect(consentUrl(state));
  });

  app.get('/connect-link', adminOnly, async (c) => {
    if (!msConfigured()) {
      return c.json({ error: 'Microsoft OAuth not configured (MS_CLIENT_ID/SECRET)' }, 400);
    }
    const agentId = c.req.query('agent_id') ?? '';
    if (!(await validateAgent(db, c.get('workspaceId'), agentId))) {
      return c.json({ error: 'pick the agent this mailbox should answer for' }, 400);
    }
    const key = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      n: c.req.query('name') || undefined,
      l: true,
      x: Date.now() + LINK_TTL_MS,
    });
    return c.json({ url: `${env.apiOrigin}/outlook/start?key=${key}` });
  });

  return app;
}

/** Public endpoints mounted at /outlook — signed-token auth, same model as
 *  the gmail routes. */
export function outlookPublicRoutes(db: Db) {
  const app = new Hono();

  app.get('/start', (c) => {
    const intent = verifyIntent(c.req.query('key') ?? '');
    if (!intent) return c.text('invalid or expired link', 400);
    return c.redirect(consentUrl(signIntent({ ...intent, x: Date.now() + STATE_TTL_MS })));
  });

  app.get('/callback', async (c) => {
    const intent = verifyIntent(c.req.query('state') ?? '');
    if (!intent) {
      return c.redirect(
        `${env.webOrigin}/agents?outlook_error=${encodeURIComponent('invalid OAuth state')}`,
      );
    }
    const done = (msg: string, ok = false) =>
      intent.l
        ? c.text(
            ok
              ? `Connected ${msg} — mail to that inbox will start appearing in Janis. You can close this tab.`
              : `Outlook connect failed: ${msg}`,
          )
        : c.redirect(
            `${env.webOrigin}/agents/${intent.a}?tab=integrations&${ok ? 'outlook_connect' : 'outlook_error'}=${encodeURIComponent(msg)}`,
          );

    const code = c.req.query('code');
    if (!code) return done(c.req.query('error_description') || 'authorization denied');
    if (!(await validateAgent(db, intent.w, intent.a))) return done('agent not found');

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${env.msTenant || 'common'}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.msClientId,
          client_secret: env.msClientSecret,
          redirect_uri: env.msRedirectUri,
          grant_type: 'authorization_code',
          scope: SCOPES,
          code,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const tok = (await tokenRes.json().catch(() => null)) as
      | {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
        }
      | null;
    if (!tokenRes.ok || !tok?.access_token) {
      return done(tok?.error_description ?? tok?.error ?? 'token exchange failed');
    }
    if (!tok.refresh_token) {
      return done('Microsoft returned no refresh token — ensure the scope includes offline_access');
    }

    const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const me = (await meRes.json().catch(() => null)) as
      | { mail?: string; userPrincipalName?: string }
      | null;
    const address = (me?.mail ?? me?.userPrincipalName ?? '').toLowerCase();
    if (!meRes.ok || !address) {
      return done(`could not read the mailbox profile (HTTP ${meRes.status})`);
    }

    const creds: ChannelCredentials = {
      via: 'oauth',
      email_address: address,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_expiry: Date.now() + (tok.expires_in ?? 3600) * 1000,
      outlook_cursor: Date.now(),
      outlook_client_state: randomBytes(16).toString('hex'),
    };

    const match = (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, intent.w), eq(channels.kind, 'outlook')))
    ).find((ch) => (ch.credentials as ChannelCredentials).email_address === address);

    if (match) {
      const prev = match.credentials as ChannelCredentials;
      await db
        .update(channels)
        .set({
          agentId: intent.a,
          name: intent.n || match.name,
          credentials: {
            ...creds,
            outlook_cursor: prev.outlook_cursor ?? creds.outlook_cursor,
            outlook_client_state: prev.outlook_client_state ?? creds.outlook_client_state,
          },
        })
        .where(eq(channels.id, match.id));
    } else {
      await db.insert(channels).values({
        workspaceId: intent.w,
        agentId: intent.a,
        kind: 'outlook',
        name: intent.n || address,
        credentials: creds,
      });
    }
    if (env.msPushToken) {
      const { renewOutlookWatches } = await import('../services/outlookSweep.js');
      void renewOutlookWatches(db).catch(() => {});
    }
    return done(address, true);
  });

  // Graph change notifications land here. Subscription creation sends a
  // ?validationToken= probe that must be echoed as plain text within 10s;
  // real notifications carry our per-channel clientState (anti-forgery) and
  // we poll instead of trusting the payload's resource ref.
  app.post('/push', async (c) => {
    const validationToken = c.req.query('validationToken');
    if (validationToken) {
      return c.text(validationToken, 200, { 'Content-Type': 'text/plain' });
    }
    if (!env.msPushToken || c.req.query('token') !== env.msPushToken) {
      return c.text('forbidden', 403);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { value?: { clientState?: string; subscriptionId?: string }[] }
      | null;
    const rows = await db.select().from(channels).where(eq(channels.kind, 'outlook'));
    for (const n of body?.value ?? []) {
      const channel = rows.find(
        (r) => (r.credentials as ChannelCredentials).outlook_client_state === n.clientState,
      );
      if (!channel) continue;
      const { pollOutlookChannel } = await import('../services/outlookSweep.js');
      void pollOutlookChannel(db, channel).catch((err) =>
        console.error(`outlook push poll ${channel.id}:`, err),
      );
    }
    // Graph retries unless we ack within ~10s — always 202 after state check.
    return c.json({ ok: true }, 202);
  });

  return app;
}
