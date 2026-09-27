import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channels } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import type { ChannelCredentials } from '../lib/channels.js';

// readonly inbox + send on the user's behalf — no mailbox modification.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');
const STATE_TTL_MS = 15 * 60 * 1000;
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/** OAuth intent carried in a signed, stateless token: which workspace/agent
 * the mailbox binds to, what to call the channel, and whether the flow came
 * from a shareable link (mailbox owner may have no Janis session). */
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
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.googleClientId);
  url.searchParams.set('redirect_uri', env.gmailRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  // select_account forces the chooser on every connect — the mailbox being
  // bound is rarely the Google account the admin is browsing as. consent is
  // required for a refresh_token on re-consent.
  url.searchParams.set('prompt', 'select_account consent');
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

/** Console endpoints mounted at /api/gmail — session auth + admin. */
export function gmailApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', (c) =>
    c.json({ configured: Boolean(env.googleClientId && env.googleClientSecret) }),
  );

  // Self-serve connect — the admin completes consent right now.
  app.get('/connect', adminOnly, async (c) => {
    if (!env.googleClientId || !env.googleClientSecret) {
      return c.json({ error: 'Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET)' }, 400);
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

  // Mint a shareable link for whoever controls the mailbox — a client, a
  // teammate, or your own other Google account. No Janis session required.
  app.get('/connect-link', adminOnly, async (c) => {
    if (!env.googleClientId || !env.googleClientSecret) {
      return c.json({ error: 'Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET)' }, 400);
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
    return c.json({ url: `${env.apiOrigin}/gmail/start?key=${key}` });
  });

  return app;
}

/** Public endpoints mounted at /gmail — the signed token IS the auth, so a
 * mailbox owner can complete the flow without a Janis session. */
export function gmailPublicRoutes(db: Db) {
  const app = new Hono();

  // Shareable entry: validate the long-lived link key, re-mint a short-lived
  // OAuth state, and send them into Google consent.
  app.get('/start', (c) => {
    const intent = verifyIntent(c.req.query('key') ?? '');
    if (!intent) return c.text('invalid or expired link', 400);
    return c.redirect(consentUrl(signIntent({ ...intent, x: Date.now() + STATE_TTL_MS })));
  });

  app.get('/callback', async (c) => {
    const intent = verifyIntent(c.req.query('state') ?? '');
    if (!intent) {
      return c.redirect(
        `${env.webOrigin}/agents?gmail_error=${encodeURIComponent('invalid OAuth state')}`,
      );
    }
    // Link flows land here for people with no Janis login — answer in text
    // instead of redirecting them at a login wall. Session flows return to
    // the agent's Channels tab (the intent carries the agent id).
    const done = (msg: string, ok = false) =>
      intent.l
        ? c.text(
            ok
              ? `Connected ${msg} — mail to that inbox will start appearing in Janis. You can close this tab.`
              : `Gmail connect failed: ${msg}`,
          )
        : c.redirect(
            `${env.webOrigin}/agents/${intent.a}?tab=integrations&${ok ? 'gmail_connect' : 'gmail_error'}=${encodeURIComponent(msg)}`,
          );

    const code = c.req.query('code');
    if (!code) return done(c.req.query('error_description') || 'authorization denied');
    if (!(await validateAgent(db, intent.w, intent.a))) return done('agent not found');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: env.gmailRedirectUri,
        grant_type: 'authorization_code',
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
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
    if (!tok.refresh_token) return done('Google returned no refresh token — try connecting again');

    const profileRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
      {
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const profile = (await profileRes.json().catch(() => null)) as
      | { emailAddress?: string }
      | null;
    if (!profileRes.ok || !profile?.emailAddress) {
      return done(
        `could not read the mailbox profile (HTTP ${profileRes.status}) — check the Gmail API is enabled and the mailbox is a test user`,
      );
    }
    const address = profile.emailAddress.toLowerCase();

    const creds: ChannelCredentials = {
      via: 'oauth',
      email_address: address,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_expiry: Date.now() + (tok.expires_in ?? 3600) * 1000,
      gmail_cursor: Date.now(), // start fresh — no mailbox backlog dump
    };

    // Reconnecting the same mailbox refreshes tokens + repoints the binding
    // instead of stacking duplicate channels.
    const match = (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, intent.w), eq(channels.kind, 'gmail')))
    ).find((ch) => (ch.credentials as ChannelCredentials).email_address === address);

    if (match) {
      const prev = match.credentials as ChannelCredentials;
      await db
        .update(channels)
        .set({
          agentId: intent.a,
          name: intent.n || match.name,
          credentials: { ...creds, gmail_cursor: prev.gmail_cursor ?? creds.gmail_cursor },
        })
        .where(eq(channels.id, match.id));
    } else {
      await db.insert(channels).values({
        workspaceId: intent.w,
        agentId: intent.a,
        kind: 'gmail',
        name: intent.n || address,
        credentials: creds,
      });
    }
    return done(address, true);
  });

  return app;
}
