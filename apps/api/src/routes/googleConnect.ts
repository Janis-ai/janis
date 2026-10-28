import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env, requestOrigin, requestWebOrigin } from '../env.js';
import { AgentConfig } from '@janis/shared';
import { agentConnections, agents } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { connectionToken } from '../lib/connections.js';
import { encryptSecret } from '../lib/secrets.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';

// Google OAuth (Janis-owned app — same client as Gmail/sign-in) — the
// Sheets/Docs tool templates' Connect button runs an authorization-code flow;
// the granted refresh token lands on agent_connections (provider 'google').
// Runtime mints short-lived access tokens per run via connections.ts.
const STATE_TTL_MS = 15 * 60 * 1000;
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
].join(' ');

/** Which workspace/agent the connection installs onto — signed, stateless. */
interface Intent {
  w: string;
  a: string;
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

function redirectUri(origin: string): string {
  return process.env.GOOGLE_CONNECT_REDIRECT_URI || `${origin}/google/callback`;
}

function consentUrl(origin: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.googleClientId);
  url.searchParams.set('redirect_uri', redirectUri(origin));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Console endpoints mounted at /api/google — session auth + admin. */
export function googleApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/connect', adminOnly, async (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const fail = (msg: string) =>
      c.redirect(
        `${requestWebOrigin(c)}/agents/${agentId}/integrations?google_error=${encodeURIComponent(msg)}`,
      );
    if (!env.googleClientId || !env.googleClientSecret) {
      return fail('Google OAuth is not configured on this Janis deployment');
    }
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) {
      return fail('pick the agent this Google account should serve');
    }
    const state = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      x: Date.now() + STATE_TTL_MS,
    });
    return c.redirect(consentUrl(requestOrigin(c), state));
  });

  return app;
}

/** Public endpoint mounted at /google — the signed state IS the auth. */
export function googlePublicRoutes(db: Db) {
  const app = new Hono();

  app.get('/callback', async (c) => {
    const intent = verifyIntent(c.req.query('state') ?? '');
    if (!intent) {
      return c.redirect(
        `${requestWebOrigin(c)}/agents?google_error=${encodeURIComponent('invalid OAuth state')}`,
      );
    }
    const done = (msg: string, ok = false) =>
      c.redirect(
        `${requestWebOrigin(c)}/agents/${intent.a}/integrations?${ok ? 'google_connect' : 'google_error'}=${encodeURIComponent(msg)}`,
      );

    const code = c.req.query('code');
    if (!code) return done(c.req.query('error_description') || 'authorization denied');

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, intent.a), eq(agents.workspaceId, intent.w)))
      .limit(1);
    if (!agent) return done('agent not found');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: redirectUri(requestOrigin(c)),
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
    if (!tokenRes.ok || !tok?.access_token || !tok.refresh_token) {
      return done(tok?.error_description ?? tok?.error ?? 'token exchange failed');
    }

    const meRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const me = (await meRes.json().catch(() => null)) as { email?: string; name?: string } | null;
    const label = me?.email || me?.name || 'Google account';

    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000);
    const creds = JSON.stringify({ refresh_token: tok.refresh_token });
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: intent.w,
        provider: 'google',
        label,
        credentialsEnc: encryptSecret(creds),
        accessTokenEnc: encryptSecret(tok.access_token),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [agentConnections.agentId, agentConnections.provider],
        set: {
          label,
          credentialsEnc: encryptSecret(creds),
          accessTokenEnc: encryptSecret(tok.access_token),
          expiresAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    try {
      await connectionToken(db, conn);
    } catch (err) {
      await db.delete(agentConnections).where(eq(agentConnections.id, conn.id));
      return done(`connected but the token check failed: ${(err as Error).message}`);
    }

    // Install BOTH Sheets + Docs templates — one Google connection serves both.
    const cfg = (agent.config ?? {}) as AgentConfig;
    let tools = cfg.tools ?? [];
    for (const tplId of ['google-sheets', 'google-docs']) {
      const tpl = TOOL_TEMPLATES.find((t) => t.id === tplId);
      if (!tpl) continue;
      const names = new Set(tpl.tools.map((t) => t.name));
      const stamped = tpl.tools.map((t) => ({ ...t, template: tpl.id }));
      tools = [...tools.filter((t) => !names.has(t.name)), ...stamped];
    }
    await db.update(agents).set({ config: { ...cfg, tools } }).where(eq(agents.id, agent.id));

    return done(label, true);
  });

  return app;
}
