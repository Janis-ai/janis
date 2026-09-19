import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import type { Db } from '../db/client.js';
import { sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, sha256, verifyPassword } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { toWorkspaceUser } from '../lib/serializers.js';
import { env } from '../env.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'janis_oauth_state';

const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });

export function authRoutes(db: Db) {
  const app = new Hono();

  const issueSession = async (c: Context, userId: string) => {
    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  app.post('/login', zValidator('json', credentials), async (c) => {
    const { email, password } = c.req.valid('json');
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    await issueSession(c, user.id);
    return c.json({ user: toWorkspaceUser(user) });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/me', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    const [row] = await db
      .select({ user: users, workspace: workspaces })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .innerJoin(workspaces, eq(users.workspaceId, workspaces.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({
      user: toWorkspaceUser(row.user),
      workspace: { id: row.workspace.id, name: row.workspace.name },
    });
  });

  // ---- OAuth (Google + Slack OpenID Connect) ----

  app.get('/providers', (c) =>
    c.json({
      google: Boolean(env.googleClientId && env.googleClientSecret),
      slack: Boolean(env.slackClientId && env.slackClientSecret),
    }),
  );

  /** Existing user by verified provider email, else provision workspace+admin. */
  const findOrProvisionUser = async (email: string, name: string) => {
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return existing;
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `${name || email.split('@')[0]}'s workspace`, plan: env.defaultPlan })
      .returning();
    const [user] = await db
      .insert(users)
      .values({ workspaceId: ws.id, email, name: name || email, role: 'admin' })
      .returning();
    return user;
  };

  const beginOAuth = (c: Context, authorizeUrl: string, params: Record<string, string>) => {
    const state = randomBytes(16).toString('hex');
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const url = new URL(authorizeUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  };

  const oauthError = (c: Context, msg: string) =>
    c.redirect(`${env.webOrigin}/login?error=${encodeURIComponent(msg)}`);

  const finishOAuth = async (
    c: Context,
    profile: { email?: string; email_verified?: boolean; name?: string } | null,
  ) => {
    if (!profile?.email || profile.email_verified === false) {
      return oauthError(c, 'sign-in failed: no verified email from provider');
    }
    const user = await findOrProvisionUser(profile.email, profile.name ?? '');
    await issueSession(c, user.id);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    return c.redirect(`${env.webOrigin}/conversations`);
  };

  const checkState = (c: Context) => {
    const sent = new URL(c.req.url).searchParams.get('state');
    const stored = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    return Boolean(sent && stored && sent === stored);
  };

  app.get('/google', (c) => {
    if (!env.googleClientId) return oauthError(c, 'Google sign-in is not configured');
    return beginOAuth(c, 'https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: env.googleClientId,
      redirect_uri: env.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
    });
  });

  const googleCallback = async (c: Context) => {
    if (!checkState(c)) return oauthError(c, 'invalid OAuth state');
    const code = new URL(c.req.url).searchParams.get('code');
    if (!code) return oauthError(c, 'missing authorization code');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: env.googleRedirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return oauthError(c, 'Google token exchange failed');
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return oauthError(c, 'Google token exchange failed');
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (!infoRes.ok) return oauthError(c, 'Google profile lookup failed');
    const info = (await infoRes.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    return finishOAuth(c, info);
  };
  app.get('/google/callback', googleCallback);
  app.get('/dialogflow', googleCallback); // legacy registered path

  app.get('/slack', (c) => {
    if (!env.slackClientId) return oauthError(c, 'Slack sign-in is not configured');
    return beginOAuth(c, 'https://slack.com/openid/connect/authorize', {
      client_id: env.slackClientId,
      redirect_uri: env.slackRedirectUri,
      response_type: 'code',
      scope: 'openid profile email',
    });
  });

  app.get('/slack/callback', async (c) => {
    if (!checkState(c)) return oauthError(c, 'invalid OAuth state');
    const code = new URL(c.req.url).searchParams.get('code');
    if (!code) return oauthError(c, 'missing authorization code');
    const tokenRes = await fetch('https://slack.com/api/openid.connect.token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.slackClientId,
        client_secret: env.slackClientSecret,
        redirect_uri: env.slackRedirectUri,
      }),
    });
    if (!tokenRes.ok) return oauthError(c, 'Slack token exchange failed');
    const token = (await tokenRes.json()) as { ok?: boolean; access_token?: string; error?: string };
    if (!token.ok || !token.access_token) {
      return oauthError(c, `Slack sign-in failed${token.error ? `: ${token.error}` : ''}`);
    }
    const infoRes = await fetch('https://slack.com/api/openid.connect.userInfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const info = (await infoRes.json()) as {
      ok?: boolean;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!info.ok) return oauthError(c, 'Slack profile lookup failed');
    return finishOAuth(c, info);
  });

  return app;
}
