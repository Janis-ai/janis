import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import type { Db } from '../db/client.js';
import { agentMembers, agents, memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, sha256, verifyPassword } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { toWorkspaceUser } from '../lib/serializers.js';
import { syncMemberToAlertChannels } from '../lib/slack.js';
import { env } from '../env.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'janis_oauth_state';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export function authRoutes(db: Db) {
  const app = new Hono();

  /** The workspace a new session should open in: the last one the user was
   * active in (when its membership is still accepted), else their first. */
  const initialWorkspace = async (userId: string) => {
    const mems = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), isNotNull(memberships.acceptedAt)));
    const [u] = await db
      .select({ lastWorkspaceId: users.lastWorkspaceId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return (
      mems.find((m) => m.workspaceId === u?.lastWorkspaceId) ?? mems[0]
    )?.workspaceId ?? null;
  };

  const issueSession = async (c: Context, userId: string, workspaceId?: string) => {
    const { token, id } = generateSessionToken();
    const wsId = workspaceId ?? (await initialWorkspace(userId));
    await db.insert(sessions).values({
      id,
      userId,
      workspaceId: wsId,
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
    if (!env.passwordLogin) {
      return c.json({ error: 'password sign-in is disabled — use Google or Slack' }, 403);
    }
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
      .select({ user: users, session: sessions })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);

    const mems = await db
      .select({ membership: memberships, workspace: workspaces })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, row.user.id));
    const active =
      mems.find(
        (m) => m.membership.acceptedAt && m.membership.workspaceId === row.session.workspaceId,
      ) ?? mems.find((m) => m.membership.acceptedAt);

    // Agent-scoped user: no membership, but agent_members rows on this
    // workspace grant them a narrow view — surface the workspace shell plus
    // the agent ids they can see so the UI can hide workspace-level nav.
    let agentScope: { id: string; name: string; role: string }[] = [];
    let scopedWorkspace: { id: string; name: string } | null = null;
    if (!active && row.session.workspaceId) {
      const rows = await db
        .select({ agentId: agentMembers.agentId, role: agentMembers.role, name: agents.name })
        .from(agentMembers)
        .innerJoin(agents, eq(agentMembers.agentId, agents.id))
        .where(
          and(
            eq(agentMembers.userId, row.user.id),
            eq(agents.workspaceId, row.session.workspaceId),
            isNotNull(agentMembers.acceptedAt),
          ),
        );
      if (rows.length) {
        agentScope = rows.map((r) => ({ id: r.agentId, name: r.name, role: r.role ?? 'member' }));
        const [ws] = await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, row.session.workspaceId))
          .limit(1);
        scopedWorkspace = ws ?? null;
      }
    }

    return c.json({
      user: toWorkspaceUser(row.user, active?.membership.role ?? 'member'),
      workspace: active
        ? { id: active.workspace.id, name: active.workspace.name }
        : scopedWorkspace,
      agent_scope: active ? null : agentScope.length ? agentScope : null,
      workspaces: mems
        .filter((m) => m.membership.acceptedAt)
        .map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          role: m.membership.role,
        })),
      invites: mems
        .filter((m) => !m.membership.acceptedAt)
        .map((m) => ({ id: m.membership.id, workspace_name: m.workspace.name })),
      support_channel_id: env.supportChannelId || null,
    });
  });

  // Switch the session's active workspace (must hold an accepted membership).
  app.post(
    '/switch',
    zValidator('json', z.object({ workspace_id: z.string() })),
    async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token) return c.json({ error: 'unauthenticated' }, 401);
      const sessionId = sha256(token);
      const [session] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
        .limit(1);
      if (!session) return c.json({ error: 'unauthenticated' }, 401);
      const [mem] = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, session.userId),
            eq(memberships.workspaceId, c.req.valid('json').workspace_id),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (!mem) return c.json({ error: 'not a member of that workspace' }, 403);
      await db
        .update(sessions)
        .set({ workspaceId: mem.workspaceId })
        .where(eq(sessions.id, sessionId));
      await db
        .update(users)
        .set({ lastWorkspaceId: mem.workspaceId })
        .where(eq(users.id, session.userId));
      return c.json({ ok: true });
    },
  );

  /** Session lookup for the identity routes below — these must work for a
   * user whose memberships are all pending (no active workspace yet), so they
   * can't sit behind sessionAuth. */
  const sessionUser = async (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const [row] = await db
      .select({ user: users, session: sessions })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  };

  // Accept a pending invite — joins the workspace and points the session at
  // it when the session has no active workspace yet.
  app.post('/invites/:id/accept', async (c) => {
    const row = await sessionUser(c);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);
    const [mem] = await db
      .update(memberships)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(memberships.id, c.req.param('id')),
          eq(memberships.userId, row.user.id),
          isNull(memberships.acceptedAt),
        ),
      )
      .returning();
    if (!mem) return c.json({ error: 'not found' }, 404);
    if (!row.session.workspaceId) {
      await db
        .update(sessions)
        .set({ workspaceId: mem.workspaceId })
        .where(eq(sessions.id, row.session.id));
    }
    await db
      .update(users)
      .set({ lastWorkspaceId: mem.workspaceId })
      .where(eq(users.id, row.user.id));
    // Slack connected → the new member joins every Janis alert channel.
    void syncMemberToAlertChannels(db, mem.workspaceId, row.user.id).catch((e) =>
      console.error('slack member sync failed:', e),
    );
    return c.json({ ok: true });
  });

  // Decline a pending invite — removes the membership entirely.
  app.post('/invites/:id/decline', async (c) => {
    const row = await sessionUser(c);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);
    const [mem] = await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.id, c.req.param('id')),
          eq(memberships.userId, row.user.id),
          isNull(memberships.acceptedAt),
        ),
      )
      .returning();
    if (!mem) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Create a workspace — the caller becomes its admin and the session
  // switches to it. Serves both the agency "add a client workspace" flow and
  // a memberless user starting fresh.
  app.post(
    '/workspaces',
    zValidator('json', z.object({ name: z.string().min(1).max(120) })),
    async (c) => {
      const row = await sessionUser(c);
      if (!row) return c.json({ error: 'unauthenticated' }, 401);
      const [ws] = await db
        .insert(workspaces)
        .values({ name: c.req.valid('json').name, plan: env.defaultPlan })
        .returning();
      await db.insert(memberships).values({
        userId: row.user.id,
        workspaceId: ws.id,
        role: 'admin',
        invitedBy: row.user.id,
        acceptedAt: new Date(),
      });
      await db
        .update(sessions)
        .set({ workspaceId: ws.id })
        .where(eq(sessions.id, row.session.id));
      await db
        .update(users)
        .set({ lastWorkspaceId: ws.id })
        .where(eq(users.id, row.user.id));
      return c.json({ workspace: { id: ws.id, name: ws.name } }, 201);
    },
  );

  // ---- OAuth (Google + Slack OpenID Connect) ----

  app.get('/providers', (c) =>
    c.json({
      google: Boolean(env.googleClientId && env.googleClientSecret),
      slack: Boolean(env.slackClientId && env.slackClientSecret),
      password: env.passwordLogin,
    }),
  );

  /** Existing user by verified provider email, else provision workspace+admin. */
  const findOrProvisionUser = async (rawEmail: string, name: string) => {
    const email = rawEmail.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return existing;
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `${name || email.split('@')[0]}'s workspace`, plan: env.defaultPlan })
      .returning();
    const [user] = await db
      .insert(users)
      .values({ email, name: name || email })
      .returning();
    await db
      .insert(memberships)
      .values({ userId: user.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
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
