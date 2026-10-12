import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { AgentConfig } from '@janis/shared';
import { agentConnections, agents } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { connectionToken } from '../lib/connections.js';
import { encryptSecret } from '../lib/secrets.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';

// Calendly OAuth (Janis-owned app, developer.calendly.com) — the Calendly
// (OAuth) tool template's Connect button runs an authorization-code flow
// instead of the customer pasting a personal access token. The granted
// refresh token lands on agent_connections (provider 'calendly'); the
// runtime mints short-lived access tokens per run and persists the rotated
// refresh token Calendly hands back.
const STATE_TTL_MS = 15 * 60 * 1000;

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

function consentUrl(state: string): string {
  const url = new URL('https://auth.calendly.com/oauth/authorize');
  url.searchParams.set('client_id', env.calendlyClientId);
  url.searchParams.set('redirect_uri', env.calendlyRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Console endpoints mounted at /api/calendly — session auth + admin. */
export function calendlyApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/status', (c) =>
    c.json({ configured: Boolean(env.calendlyClientId && env.calendlyClientSecret) }),
  );

  // Connect — the admin completes Calendly consent right now. Redirects
  // straight to Calendly; /calendly/callback does the exchange + install.
  app.get('/connect', adminOnly, async (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const fail = (msg: string) =>
      c.redirect(
        `${env.webOrigin}/agents/${agentId}/integrations?calendly_error=${encodeURIComponent(msg)}`,
      );
    if (!env.calendlyClientId || !env.calendlyClientSecret) {
      return fail('Calendly OAuth is not configured on this Janis deployment');
    }
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) {
      return fail('pick the agent this Calendly account should serve');
    }
    const state = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      x: Date.now() + STATE_TTL_MS,
    });
    return c.redirect(consentUrl(state));
  });

  return app;
}

/** Public endpoint mounted at /calendly — the signed state IS the auth. */
export function calendlyPublicRoutes(db: Db) {
  const app = new Hono();

  app.get('/callback', async (c) => {
    const intent = verifyIntent(c.req.query('state') ?? '');
    if (!intent) {
      return c.redirect(
        `${env.webOrigin}/agents?calendly_error=${encodeURIComponent('invalid OAuth state')}`,
      );
    }
    const done = (msg: string, ok = false) =>
      c.redirect(
        `${env.webOrigin}/agents/${intent.a}/integrations?${ok ? 'calendly_connect' : 'calendly_error'}=${encodeURIComponent(msg)}`,
      );

    const code = c.req.query('code');
    if (!code) return done(c.req.query('error_description') || 'authorization denied');

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, intent.a), eq(agents.workspaceId, intent.w)))
      .limit(1);
    if (!agent) return done('agent not found');

    // Code → tokens. Calendly wants HTTP Basic with the app credentials,
    // not client_id/secret in the body.
    const tokenRes = await fetch('https://auth.calendly.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${env.calendlyClientId}:${env.calendlyClientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: env.calendlyRedirectUri,
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json().catch(() => null)) as
      | {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          owner?: string; // user uri
          error?: string;
          error_description?: string;
        }
      | null;
    if (!tokenRes.ok || !tok?.access_token || !tok.refresh_token) {
      return done(tok?.error_description ?? tok?.error ?? 'token exchange failed');
    }

    // Who connected — the connection label and a name for the success flash.
    const meRes = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const me = (await meRes.json().catch(() => null)) as
      | { resource?: { name?: string; email?: string } }
      | null;
    const label = me?.resource?.name || me?.resource?.email || 'Calendly account';

    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 7200) * 1000);
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: intent.w,
        provider: 'calendly',
        label,
        credentialsEnc: encryptSecret(JSON.stringify({ refresh_token: tok.refresh_token })),
        accessTokenEnc: encryptSecret(tok.access_token),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [agentConnections.agentId, agentConnections.provider],
        set: {
          label,
          credentialsEnc: encryptSecret(JSON.stringify({ refresh_token: tok.refresh_token })),
          accessTokenEnc: encryptSecret(tok.access_token),
          expiresAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Prove the connection end-to-end before claiming success — a refresh
    // that already fails here would fail silently mid-conversation.
    try {
      await connectionToken(db, conn);
    } catch (err) {
      await db.delete(agentConnections).where(eq(agentConnections.id, conn.id));
      return done(`connected but the token check failed: ${(err as Error).message}`);
    }

    // Install the template's tools (name-merge, same as the install route)
    // so the agent can actually use the connection we just stored.
    const tpl = TOOL_TEMPLATES.find((t) => t.id === 'calendly-connect');
    if (tpl) {
      const cfg = (agent.config ?? {}) as AgentConfig;
      const names = new Set(tpl.tools.map((t) => t.name));
      const stamped = tpl.tools.map((t) => ({ ...t, template: tpl.id }));
      const tools = [...(cfg.tools ?? []).filter((t) => !names.has(t.name)), ...stamped];
      await db
        .update(agents)
        .set({ config: { ...cfg, tools } })
        .where(eq(agents.id, agent.id));
    }
    return done(label, true);
  });

  return app;
}
