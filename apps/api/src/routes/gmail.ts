import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { agents, channels } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import type { ChannelCredentials } from '../lib/channels.js';

const STATE_COOKIE = 'janis_gmail_state';
const PENDING_TTL_MS = 15 * 60 * 1000;
// readonly inbox + send on the user's behalf — no mailbox modification.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

// OAuth intent carried across the redirect: which agent the mailbox binds
// to and what to call the channel.
const pending = new Map<string, { agentId: string; name: string; expiresAt: number }>();

/** Console endpoints mounted at /api/gmail (session auth + OAuth callback). */
export function gmailApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', (c) =>
    c.json({ configured: Boolean(env.googleClientId && env.googleClientSecret) }),
  );

  // Step 1: kick off Google OAuth for a mailbox → agent binding.
  app.get('/connect', adminOnly, async (c) => {
    if (!env.googleClientId || !env.googleClientSecret) {
      return c.json({ error: 'Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET)' }, 400);
    }
    const agentId = c.req.query('agent_id') ?? '';
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'pick the agent this mailbox should answer for' }, 400);

    const nonce = randomBytes(16).toString('hex');
    pending.set(nonce, {
      agentId,
      name: c.req.query('name') ?? '',
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    setCookie(c, STATE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', env.googleClientId);
    url.searchParams.set('redirect_uri', env.gmailRedirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline');
    // consent prompt is required for a refresh_token on every connect —
    // without it Google omits refresh_token on re-consent.
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', nonce);
    return c.redirect(url.toString());
  });

  // Step 2: exchange code → tokens → mailbox identity → channel row.
  app.get('/callback', adminOnly, async (c) => {
    const back = (msg: string) =>
      c.redirect(`${env.webOrigin}/integrations?gmail_error=${encodeURIComponent(msg)}`);
    const nonce = c.req.query('state') ?? '';
    const stored = getCookie(c, STATE_COOKIE);
    const intent = pending.get(nonce);
    pending.delete(nonce);
    if (!nonce || !stored || stored !== nonce || !intent || intent.expiresAt < Date.now()) {
      return back('invalid OAuth state');
    }
    const code = c.req.query('code');
    if (!code) return back(c.req.query('error_description') || 'authorization denied');

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
      return back(tok?.error_description ?? tok?.error ?? 'token exchange failed');
    }
    if (!tok.refresh_token) return back('Google returned no refresh token — try connecting again');

    const profileRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
      { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) },
    );
    const profile = (await profileRes.json().catch(() => null)) as
      | { emailAddress?: string }
      | null;
    if (!profileRes.ok || !profile?.emailAddress) {
      return back('could not read the mailbox profile — check the Gmail API is enabled');
    }
    const address = profile.emailAddress.toLowerCase();

    const workspaceId = c.get('workspaceId');
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
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.kind, 'gmail')))
    ).find((ch) => (ch.credentials as ChannelCredentials).email_address === address);

    if (match) {
      const prev = match.credentials as ChannelCredentials;
      await db
        .update(channels)
        .set({
          agentId: intent.agentId,
          name: intent.name || match.name,
          credentials: { ...creds, gmail_cursor: prev.gmail_cursor ?? creds.gmail_cursor },
        })
        .where(eq(channels.id, match.id));
    } else {
      await db.insert(channels).values({
        workspaceId,
        agentId: intent.agentId,
        kind: 'gmail',
        name: intent.name || address,
        credentials: creds,
      });
    }
    return c.redirect(`${env.webOrigin}/integrations?gmail_connect=${encodeURIComponent(address)}`);
  });

  return app;
}
