import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import type { Db } from '../db/client.js';
import { agentMembers, agents, conversations, emailVerificationTokens, memberships, passwordResetTokens, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { passwordIssue } from '../lib/passwordCheck.js';
import { dbRateLimit } from '../lib/rateLimit.js';
import { sendEmail } from '../lib/notify.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { toWorkspaceUser } from '../lib/serializers.js';
import { syncMemberToAlertChannels } from '../lib/slack.js';
import { env } from '../env.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'janis_oauth_state';
const RESET_TTL_MS = 60 * 60 * 1000; // password-reset links live 1h
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // verification links live 24h

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(128),
});

const newCredentials = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  // length is the only real rule — breach/common checks run server-side
  password: z.string().min(8).max(128),
  name: z.string().trim().max(120).optional(),
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
    const memberWs =
      (mems.find((m) => m.workspaceId === u?.lastWorkspaceId) ?? mems[0])?.workspaceId;
    if (memberWs) return memberWs;
    // Agent-scoped users hold no memberships — land on the workspace their
    // agent grants live in so the scoped shell renders instead of nothing.
    const scoped = await db
      .select({ workspaceId: agents.workspaceId })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, userId),
          isNotNull(agentMembers.acceptedAt),
          ne(agentMembers.role, 'hidden'),
        ),
      );
    return (
      scoped.find((s) => s.workspaceId === u?.lastWorkspaceId)?.workspaceId ??
      scoped[0]?.workspaceId ??
      null
    );
  };

  /** Switcher list: accepted memberships plus workspaces reachable only via
   * agent grants (agent-scoped users see them so they can switch to them). */
  const workspaceListFor = async (userId: string) => {
    const mems = await db
      .select({ workspace: workspaces, membership: memberships })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(and(eq(memberships.userId, userId), isNotNull(memberships.acceptedAt)));
    const list: {
      id: string;
      name: string;
      role: 'admin' | 'member';
      agent_scoped?: boolean;
    }[] = mems.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.membership.role as 'admin' | 'member',
    }));
    const scoped = await db
      .selectDistinct({ workspaceId: agents.workspaceId })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, userId),
          isNotNull(agentMembers.acceptedAt),
          ne(agentMembers.role, 'hidden'),
        ),
      );
    const seen = new Set(list.map((w) => w.id));
    for (const s of scoped) {
      if (seen.has(s.workspaceId)) continue;
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, s.workspaceId))
        .limit(1);
      // agent_scoped flags grant-only workspaces so the switcher can label
      // them — agent_invites lists the same rows as "added to" notices and
      // the switcher would otherwise show the workspace twice.
      if (ws) list.push({ id: ws.id, name: ws.name, role: 'member', agent_scoped: true });
    }
    return list;
  };

  /** Every account owns a workspace. Users created by an invite or agent
   *  grant skip provisioning (they hold only a pending membership or an
   *  agent_members row), so heal lazily at login — otherwise an invited
   *  teammate sees the shared agent and nothing of their own. */
  const ensurePersonalWorkspace = async (userId: string) => {
    const [owned] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId))
      .limit(1);
    if (owned) return;
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return;
    // Don't let the fresh workspace steal the landing of a user who already
    // belongs to one — pin an existing membership as "last used" first so
    // initialWorkspace's find() keeps them where they were.
    if (!u.lastWorkspaceId) {
      const [existing] = await db
        .select({ workspaceId: memberships.workspaceId })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), isNotNull(memberships.acceptedAt)))
        .orderBy(asc(memberships.createdAt))
        .limit(1);
      if (existing) {
        await db
          .update(users)
          .set({ lastWorkspaceId: existing.workspaceId })
          .where(eq(users.id, userId));
      }
    }
    // First name keeps the default short — "Michael's workspace" sits better
    // in the switcher and invite emails than "Michael Nathanson's workspace".
    const base =
      u.name && u.name !== u.email ? u.name.split(' ')[0] : u.email.split('@')[0];
    await db.transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({
          name: `${base}'s workspace`,
          plan: env.defaultPlan,
          ownerUserId: u.id,
          config: { data_retention_days: 365 },
        })
        .returning();
      await tx.insert(memberships).values({
        userId: u.id,
        workspaceId: ws.id,
        role: 'admin',
        acceptedAt: new Date(),
      });
    });
  };

  const issueSession = async (c: Context, userId: string, workspaceId?: string) => {
    const { token, id } = generateSessionToken();
    await ensurePersonalWorkspace(userId);
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

  // A miss short-circuits verifyPassword, leaking "no such account" by
  // timing — always run a scrypt compare against this pad on the miss path.
  let dummyHash: string | null = null;
  const timingPad = async () =>
    (dummyHash ??= await hashPassword(`pad-${randomBytes(16).toString('hex')}`));

  app.post(
    '/login',
    dbRateLimit(db, { scope: 'login', max: 10, windowMs: 10 * 60_000 }),
    zValidator('json', credentials),
    async (c) => {
    if (!env.passwordLogin) {
      return c.json({ error: 'password sign-in is disabled — use Google or Slack' }, 403);
    }
    const { email, password } = c.req.valid('json');
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const ok = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : false;
    if (!ok || !user) {
      await verifyPassword(password, await timingPad()); // equalize the timing
      return c.json({ error: 'invalid credentials' }, 401);
    }
    if (!user.emailVerifiedAt) {
      return c.json({ error: 'unverified', detail: 'Confirm your email first — check your inbox for the verification link.' }, 403);
    }
    await issueSession(c, user.id);
    return c.json({ user: toWorkspaceUser(user) });
    },
  );

  /** Mint a fresh verification link — burns any older unused ones. */
  const sendVerification = async (user: { id: string; email: string; name: string }) => {
    await db
      .delete(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.usedAt)));
    const raw = randomBytes(32).toString('base64url');
    await db.insert(emailVerificationTokens).values({
      userId: user.id,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });
    await sendEmail(
      [user.email],
      'Confirm your Janis email',
      `Hi ${user.name.split(' ')[0] || 'there'} — confirm this is your email to activate your Janis account. The link works once and expires in 24 hours. If you didn't sign up, ignore this email.`,
      `/verify-email?token=${raw}`,
    );
  };

  // Email signup — the account exists immediately but no session is issued
  // until the emailed link is clicked. An existing email 409s: blunt,
  // rate-limited, and the friendlier path is a reset — deliberately NOT a
  // silent merge onto an OAuth-only account (password-only takeover route).
  app.post(
    '/signup',
    dbRateLimit(db, { scope: 'signup', max: 10, windowMs: 60 * 60_000 }),
    zValidator('json', newCredentials),
    async (c) => {
      if (!env.passwordLogin) {
        return c.json({ error: 'password sign-in is disabled — use Google or Slack' }, 403);
      }
      const { email, password, name } = c.req.valid('json');
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing) {
        return c.json(
          { error: 'An account with this email already exists — sign in or reset your password' },
          409,
        );
      }
      const issue = await passwordIssue(password);
      if (issue) return c.json({ error: issue }, 400);
      const [user] = await db
        .insert(users)
        .values({
          email,
          name: name || email.split('@')[0],
          passwordHash: await hashPassword(password),
        })
        .returning();
      await sendVerification(user);
      return c.json({ needsVerification: true }, 201);
    },
  );

  // Resend the verification link — always 200 so it can't enumerate.
  app.post(
    '/resend-verification',
    dbRateLimit(db, { scope: 'resend-verify', max: 5, windowMs: 60 * 60_000 }),
    zValidator('json', z.object({ email: z.string().trim().toLowerCase().email().max(320) })),
    async (c) => {
      if (!env.passwordLogin) return c.json({ ok: true });
      const { email } = c.req.valid('json');
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (user && !user.emailVerifiedAt) await sendVerification(user);
      return c.json({ ok: true });
    },
  );

  // Verify — burns the single-use token, welcomes the account, and issues
  // the first session so the emailed link lands signed in.
  app.post(
    '/verify',
    dbRateLimit(db, { scope: 'verify', max: 10, windowMs: 10 * 60_000 }),
    zValidator('json', z.object({ token: z.string().min(20).max(200) })),
    async (c) => {
      const { token } = c.req.valid('json');
      const [row] = await db
        .select({ tok: emailVerificationTokens, user: users })
        .from(emailVerificationTokens)
        .innerJoin(users, eq(emailVerificationTokens.userId, users.id))
        .where(eq(emailVerificationTokens.tokenHash, sha256(token)))
        .limit(1);
      if (!row || row.tok.usedAt || row.tok.expiresAt < new Date()) {
        return c.json({ error: 'That verification link is expired or already used — request a fresh one' }, 400);
      }
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, row.user.id));
      await db
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.id, row.tok.id));
      await sendEmail(
        [row.user.email],
        'Welcome to Janis',
        `Hi ${row.user.name.split(' ')[0] || 'there'} — your email is confirmed and your account is live. Your workspace is ready: connect a channel, drop the widget on your site, and Janis starts answering.`,
        '/conversations',
      );
      await issueSession(c, row.user.id);
      return c.json({ user: toWorkspaceUser(row.user) });
    },
  );

  // Forgot password — always 200 so the endpoint can't enumerate accounts;
  // the rate limit blunts address-probing anyway. A reset on an OAuth-only
  // account is the sanctioned "add a password" path: the emailed link proves
  // inbox ownership before a password is set.
  app.post(
    '/forgot',
    dbRateLimit(db, { scope: 'forgot', max: 5, windowMs: 60 * 60_000 }),
    zValidator('json', z.object({ email: z.string().trim().toLowerCase().email().max(320) })),
    async (c) => {
      if (!env.passwordLogin) return c.json({ ok: true });
      const { email } = c.req.valid('json');
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (user) {
        // One live token per account — minting anew burns older links.
        await db
          .delete(passwordResetTokens)
          .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
        const raw = randomBytes(32).toString('base64url');
        await db.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        });
        await sendEmail(
          [user.email],
          'Reset your Janis password',
          `Hi ${user.name.split(' ')[0] || 'there'} — someone asked to reset the password on this Janis account. The link works once and expires in 1 hour. If that wasn't you, ignore this email — your password is unchanged.`,
          `/reset-password?token=${raw}`,
        );
      }
      return c.json({ ok: true });
    },
  );

  // Reset — single-use hashed token, then revoke every live session so the
  // new password is the only way back in. The fresh session logs them in.
  app.post(
    '/reset',
    dbRateLimit(db, { scope: 'reset', max: 10, windowMs: 10 * 60_000 }),
    zValidator('json', z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(128) })),
    async (c) => {
      if (!env.passwordLogin) {
        return c.json({ error: 'password sign-in is disabled — use Google or Slack' }, 403);
      }
      const { token, password } = c.req.valid('json');
      const [row] = await db
        .select({ tok: passwordResetTokens, user: users })
        .from(passwordResetTokens)
        .innerJoin(users, eq(passwordResetTokens.userId, users.id))
        .where(eq(passwordResetTokens.tokenHash, sha256(token)))
        .limit(1);
      if (!row || row.tok.usedAt || row.tok.expiresAt < new Date()) {
        return c.json({ error: 'That reset link is expired or already used — request a fresh one' }, 400);
      }
      const issue = await passwordIssue(password);
      if (issue) return c.json({ error: issue }, 400);
      await db
        .update(users)
        // A working reset link proves inbox ownership — count it as verified.
        .set({ passwordHash: await hashPassword(password), emailVerifiedAt: new Date() })
        .where(eq(users.id, row.user.id));
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, row.tok.id));
      await db.delete(sessions).where(eq(sessions.userId, row.user.id));
      await issueSession(c, row.user.id);
      return c.json({ user: toWorkspaceUser(row.user) });
    },
  );

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

    // Sessions outlive logins — heal here too so an invited teammate with a
    // live session gets their personal workspace without signing in again.
    await ensurePersonalWorkspace(row.user.id);

    const mems = await db
      .select({ membership: memberships, workspace: workspaces })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, row.user.id));
    // The session pins which workspace is active — don't fall back to just
    // any membership here, or a switch into a grant-only workspace snaps
    // right back on the next /me.
    let active = mems.find(
      (m) => m.membership.acceptedAt && m.membership.workspaceId === row.session.workspaceId,
    );

    // Sessions minted before agent grants existed (or while none did) carry
    // workspaceId=null — re-resolve so a later agent invite heals the shell.
    if (!active && !row.session.workspaceId) {
      const wsId = await initialWorkspace(row.user.id);
      if (wsId) {
        await db
          .update(sessions)
          .set({ workspaceId: wsId })
          .where(eq(sessions.id, row.session.id));
        row.session.workspaceId = wsId;
        active = mems.find(
          (m) => m.membership.acceptedAt && m.membership.workspaceId === wsId,
        );
      }
    }

    // Agent-scoped user: no membership, but agent_members rows on this
    // workspace grant them a narrow view — surface the workspace shell plus
    // the agent ids they can see so the UI can hide workspace-level nav.
    let agentScope: { id: string; name: string; role: string }[] = [];
    let scopedWorkspace: { id: string; name: string; ownerId: string | null } | null = null;
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
            ne(agentMembers.role, 'hidden'),
          ),
        );
      if (rows.length) {
        agentScope = rows.map((r) => ({ id: r.agentId, name: r.name, role: r.role ?? 'member' }));
        const [ws] = await db
          .select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerUserId })
          .from(workspaces)
          .where(eq(workspaces.id, row.session.workspaceId))
          .limit(1);
        scopedWorkspace = ws ?? null;
      }
    }

    // Agent grants on workspaces the user isn't a member of — auto-accepted,
    // so there's no accept step; surfaced as "you've been added" rows the UI
    // renders with a Switch action (otherwise the grant is invisible).
    const memberWsIds = new Set(
      mems.filter((m) => m.membership.acceptedAt).map((m) => m.workspace.id),
    );
    const grants = await db
      .select({ workspaceId: agents.workspaceId, agentName: agents.name })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, row.user.id),
          isNotNull(agentMembers.acceptedAt),
          ne(agentMembers.role, 'hidden'),
        ),
      );
    const grantWs = new Map<string, string[]>();
    for (const g of grants) {
      if (memberWsIds.has(g.workspaceId)) continue;
      grantWs.set(g.workspaceId, [...(grantWs.get(g.workspaceId) ?? []), g.agentName]);
    }
    const agentInvites: { workspace_id: string; workspace_name: string; agents: string[] }[] = [];
    for (const [wsId, agentNames] of grantWs) {
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, wsId))
        .limit(1);
      if (ws) agentInvites.push({ workspace_id: ws.id, workspace_name: ws.name, agents: agentNames });
    }

    return c.json({
      user: toWorkspaceUser(row.user, active?.membership.role ?? 'member'),
      workspace: active
        ? {
            id: active.workspace.id,
            name: active.workspace.name,
            owner_id: active.workspace.ownerUserId,
          }
        : scopedWorkspace
          ? { id: scopedWorkspace.id, name: scopedWorkspace.name, owner_id: scopedWorkspace.ownerId }
          : null,
      agent_scope: active ? null : agentScope.length ? agentScope : null,
      workspaces: await workspaceListFor(row.user.id),
      invites: mems
        .filter((m) => !m.membership.acceptedAt)
        .map((m) => ({ id: m.membership.id, workspace_name: m.workspace.name })),
      agent_invites: agentInvites,
      support_channel_id: env.supportChannelId || null,
      // Janis-internal surfaces (error reports) — only the operator workspace.
      operator:
        Boolean(env.operatorWorkspaceId) &&
        (active?.workspace.id ?? scopedWorkspace?.id) === env.operatorWorkspaceId,
    });
  });

  // Switch the session's active workspace (must hold an accepted membership).
  app.post(
    '/switch',
    zValidator(
      'json',
      z.object({
        workspace_id: z.string().optional(),
        // Deep-link mode: "switch to whichever workspace owns this
        // conversation" (alert/invite email links). Resolves the owning
        // workspace and confirms the user could actually see the
        // conversation there before moving the session — a uniform 404
        // otherwise, so the probe can't map other workspaces' ids.
        for_conversation: z.string().optional(),
      }),
    ),
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
      const body = c.req.valid('json');
      if (!body.workspace_id && !body.for_conversation) {
        return c.json({ error: 'workspace_id required' }, 400);
      }

      if (body.for_conversation) {
        const [owner] = await db
          .select({ agentId: agents.id, ws: agents.workspaceId })
          .from(conversations)
          .innerJoin(agents, eq(conversations.agentId, agents.id))
          .where(eq(conversations.id, body.for_conversation))
          .limit(1);
        if (!owner) return c.json({ error: 'not found' }, 404);
        const [mem] = await db
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, session.userId),
              eq(memberships.workspaceId, owner.ws),
              isNotNull(memberships.acceptedAt),
            ),
          )
          .limit(1);
        // A member sees the conversation unless an agent_members row hides
        // the agent from them; a non-member needs an accepted grant on this
        // specific agent — anything else 404s rather than revealing the
        // conversation's existence.
        const [grant] = await db
          .select({ role: agentMembers.role })
          .from(agentMembers)
          .where(
            and(
              eq(agentMembers.userId, session.userId),
              eq(agentMembers.agentId, owner.agentId),
              isNotNull(agentMembers.acceptedAt),
            ),
          )
          .limit(1);
        if (mem ? grant?.role === 'hidden' : !grant || grant.role === 'hidden') {
          return c.json({ error: 'not found' }, 404);
        }
        if (session.workspaceId === owner.ws) {
          // Already in the right workspace — the 404 the client saw means
          // something else; tell it not to reload-loop.
          return c.json({ ok: true, workspace_id: owner.ws, unchanged: true });
        }
        await db
          .update(sessions)
          .set({ workspaceId: owner.ws })
          .where(eq(sessions.id, sessionId));
        await db
          .update(users)
          .set({ lastWorkspaceId: owner.ws })
          .where(eq(users.id, session.userId));
        return c.json({ ok: true, workspace_id: owner.ws });
      }

      const targetWs = body.workspace_id!;
      const [mem] = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, session.userId),
            eq(memberships.workspaceId, targetWs),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      // Agent-scoped users may switch to a workspace they only reach through
      // agent grants — the scoped shell renders there.
      if (!mem) {
        const [grant] = await db
          .select({ agentId: agentMembers.agentId })
          .from(agentMembers)
          .innerJoin(agents, eq(agentMembers.agentId, agents.id))
          .where(
            and(
              eq(agentMembers.userId, session.userId),
              eq(agents.workspaceId, targetWs),
              isNotNull(agentMembers.acceptedAt),
              ne(agentMembers.role, 'hidden'),
            ),
          )
          .limit(1);
        if (!grant) return c.json({ error: 'not a member of that workspace' }, 403);
      }
      await db
        .update(sessions)
        .set({ workspaceId: targetWs })
        .where(eq(sessions.id, sessionId));
      await db
        .update(users)
        .set({ lastWorkspaceId: targetWs })
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
  // it (accepting is explicit intent to go there, not just a background join).
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
    await db
      .update(sessions)
      .set({ workspaceId: mem.workspaceId })
      .where(eq(sessions.id, row.session.id));
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
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        // Agency "add a client workspace" — parents the new workspace to the
        // caller's current one so plan inheritance and Connect rebilling
        // kick in. Clients can't nest under clients.
        client: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const row = await sessionUser(c);
      if (!row) return c.json({ error: 'unauthenticated' }, 401);
      const body = c.req.valid('json');
      let parentId: string | undefined;
      let parentContact: string | undefined;
      if (body.client && row.session.workspaceId) {
        const [parent] = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, row.session.workspaceId))
          .limit(1);
        if (parent?.parentWorkspaceId) {
          return c.json({ error: 'client workspaces cannot have clients of their own' }, 400);
        }
        parentId = parent?.id;
        parentContact = parent?.name;
      }
      const [ws] = await db
        .insert(workspaces)
        .values({
          name: body.name,
          plan: env.defaultPlan,
          ownerUserId: row.user.id,
          parentWorkspaceId: parentId,
          parentContact,
          config: { data_retention_days: 365 },
        })
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
      sso: Boolean(env.workosClientId && env.workosApiKey),
      password: env.passwordLogin,
    }),
  );

  /** Existing user by verified provider email, else create the account. The
   *  provider vouched for the email — mark it verified on create AND on
   *  sign-in (an SSO pass repairs an unverified password-only account). The
   *  personal workspace is provisioned in issueSession so invite-created
   *  users heal on their first login too. */
  const findOrProvisionUser = async (rawEmail: string, name: string) => {
    const email = rawEmail.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      if (!existing.emailVerifiedAt) {
        await db
          .update(users)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(users.id, existing.id));
      }
      return existing;
    }
    const [user] = await db
      .insert(users)
      .values({ email, name: name || email, emailVerifiedAt: new Date() })
      .returning();
    return user;
  };

  const beginOAuth = (
    c: Context,
    authorizeUrl: string,
    params: Record<string, string>,
    statePrefix = '',
  ) => {
    const state = statePrefix + randomBytes(16).toString('hex');
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const url = new URL(authorizeUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('state', state);
    // 302s are cacheable — a replayed authorize URL carries a dead state and
    // the callback rejects it. Force the browser back through /auth/* for a
    // fresh state cookie on every sign-in attempt.
    c.header('Cache-Control', 'no-store');
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

  // ---- Enterprise SSO (WorkOS) ----------------------------------------
  // /auth/sso?connection=<id> | organization=<id> | domain=acme.com —
  // WorkOS brokers SAML/OIDC to the customer's IdP; we get a verified
  // profile back on the callback. Membership still comes from an existing
  // Janis account or invite — SSO proves identity, not authorization.
  //
  // Two WorkOS surfaces: user_management (AuthKit — providers/hosted UI)
  // and the standalone SSO product (api.workos.com/sso/*). SAML/OIDC
  // customer connections resolve ONLY on sso/authorize — user_management
  // can't route them on non-migrated environments (ours is one). The
  // `sso_`/`um_` state prefix tells the callback which exchange to use.
  const ssoOrgForDomain = async (domain: string): Promise<string | undefined> => {
    // WorkOS deprecated bare-domain routing, so we resolve it ourselves:
    // the workspace that claimed this domain in Settings, then WorkOS's
    // org-domain registry (covers orgs created outside our portal flow).
    const [row] = await db
      .select({ oid: sql<string>`config->'workos'->>'organization_id'` })
      .from(workspaces)
      .where(sql`config->'workos'->>'domain' = ${domain}`)
      .limit(1);
    if (row?.oid) return row.oid;
    try {
      const res = await fetch(
        `https://api.workos.com/organizations?domains=${encodeURIComponent(domain)}`,
        { headers: { authorization: `Bearer ${env.workosApiKey}` } },
      );
      const list = (await res.json()) as { data?: { id?: string }[] };
      return list.data?.[0]?.id;
    } catch {
      return undefined;
    }
  };

  app.get('/sso', async (c) => {
    if (!env.workosClientId || !env.workosApiKey) {
      return oauthError(c, 'SSO is not configured on this deployment');
    }
    const q = new URL(c.req.url).searchParams;
    const base: Record<string, string> = {
      client_id: env.workosClientId,
      redirect_uri: env.workosRedirectUri,
      response_type: 'code',
    };
    const provider = q.get('provider');
    const loginHint = q.get('login_hint');
    if (provider || loginHint) {
      return beginOAuth(
        c,
        'https://api.workos.com/user_management/authorize',
        {
          ...base,
          ...(provider ? { provider } : {}),
          ...(loginHint ? { login_hint: loginHint } : {}),
        },
        'um_',
      );
    }
    let organization = q.get('organization');
    const domain = q.get('domain')?.trim().toLowerCase();
    if (!organization && domain) {
      organization = (await ssoOrgForDomain(domain)) ?? null;
      if (!organization) {
        return oauthError(
          c,
          `No organization is set up for ${domain} — check your sign-in link or ask your admin`,
        );
      }
    }
    const connection = q.get('connection');
    if (!connection && !organization) {
      return oauthError(c, 'SSO requires ?connection, ?organization, or ?domain');
    }
    return beginOAuth(
      c,
      'https://api.workos.com/sso/authorize',
      {
        ...base,
        ...(connection ? { connection } : {}),
        ...(organization ? { organization } : {}),
      },
      'sso_',
    );
  });

  app.get('/sso/callback', async (c) => {
    if (!checkState(c)) return oauthError(c, 'invalid OAuth state');
    const q = new URL(c.req.url).searchParams;
    // WorkOS bounces selector/config errors back to the callback — surface
    // their reason instead of a generic "missing code".
    const errDesc = q.get('error_description') ?? q.get('error');
    if (errDesc) return oauthError(c, `SSO: ${errDesc}`);
    const code = q.get('code');
    if (!code) return oauthError(c, 'missing authorization code');
    if ((q.get('state') ?? '').startsWith('sso_')) {
      const res = await fetch('https://api.workos.com/sso/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.workosClientId,
          client_secret: env.workosApiKey,
          code,
        }),
      });
      if (!res.ok) return oauthError(c, 'SSO authentication failed');
      const data = (await res.json()) as {
        profile?: { email?: string; first_name?: string; last_name?: string };
      };
      const p = data.profile;
      const name = [p?.first_name, p?.last_name].filter(Boolean).join(' ');
      return finishOAuth(c, { email: p?.email, name });
    }
    const res = await fetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.workosClientId,
        client_secret: env.workosApiKey,
        code,
      }),
    });
    if (!res.ok) return oauthError(c, 'SSO authentication failed');
    const data = (await res.json()) as {
      user?: {
        email?: string;
        email_verified?: boolean;
        first_name?: string;
        last_name?: string;
      };
    };
    const u = data.user;
    const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ');
    return finishOAuth(c, { email: u?.email, email_verified: u?.email_verified, name });
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
