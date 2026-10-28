import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env, requestOrigin, requestWebOrigin } from '../env.js';
import { AgentConfig } from '@janis/shared';
import { agentConnections, agents } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { connectionCreds, connectionToken } from '../lib/connections.js';
import { encryptSecret } from '../lib/secrets.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';

// Google OAuth (Janis-owned app — same client as Gmail/sign-in) — the
// Sheets/Docs tool templates' Connect button runs an authorization-code flow;
// the granted refresh token lands on agent_connections (provider 'google').
// Runtime mints short-lived access tokens per run via connections.ts.
const STATE_TTL_MS = 15 * 60 * 1000;
// drive.file (non-restricted) covers docs the agent creates or the user
// opens — drive.readonly would let *_list enumerate ALL files but lands in
// Google's restricted tier (CASA assessment); not worth it for a
// convenience listing.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
].join(' ');

/** Which workspace/agent the connection installs onto — signed, stateless. */
interface Intent {
  w: string;
  a: string;
  t: string; // which google-* template card initiated the connect
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
    return i.w && i.a && i.t && i.x > Date.now() ? i : null;
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
    const tplId = c.req.query('tpl') ?? 'google-sheets';
    const state = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      t: tplId,
      x: Date.now() + STATE_TTL_MS,
    });
    return c.redirect(consentUrl(requestOrigin(c), state));
  });

  // Picker bootstrap — the console's "Pick Drive files" button needs a
  // short-lived OAuth access token + the project's picker creds. Admin-only;
  // the token is the operator's own connection token.
  app.get('/picker-token', adminOnly, async (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const [conn] = await db
      .select()
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.agentId, agentId),
          eq(agentConnections.workspaceId, c.get('workspaceId')),
          eq(agentConnections.provider, 'google'),
        ),
      )
      .limit(1);
    if (!conn) return c.json({ error: 'no google connection — connect first' }, 404);
    const accessToken = await connectionToken(db, conn);
    return c.json({
      access_token: accessToken,
      developer_key: process.env.GOOGLE_API_KEY ?? '',
      app_id: process.env.GOOGLE_PICKER_APP_ID ?? '',
    });
  });

  // Whether a Google connection exists for this agent — other google-*
  // cards render "Add" (install tools, no re-consent) instead of Connect.
  app.get('/connection', adminOnly, async (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const [conn] = await db
      .select({ label: agentConnections.label })
      .from(agentConnections)
      .where(
        and(
          eq(agentConnections.agentId, agentId),
          eq(agentConnections.workspaceId, c.get('workspaceId')),
          eq(agentConnections.provider, 'google'),
        ),
      )
      .limit(1);
    return c.json({ connected: Boolean(conn), label: conn?.label ?? null });
  });

  // Drive files the connection can see — picked files, app-created, opened.
  app.get('/files', adminOnly, async (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const conn = await googleConn(db, agentId, c.get('workspaceId'));
    if (!conn) return c.json({ files: [] });
    const token = await connectionToken(db, conn);
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,webViewLink,modifiedTime)&orderBy=modifiedTime+desc&pageSize=100',
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    const data = (await res.json().catch(() => ({}))) as { files?: { id: string }[] };
    const excl = excludedFiles(conn);
    return c.json({ files: (data.files ?? []).filter((f) => !excl.has(f.id)) });
  });

  // Unshare a file — drop it from the connection's exclusion-aware listings.
  // drive.file access is scope-level (no per-file Google revoke), so the
  // exclusion list is the agent's effective view; removing the template +
  // connection is the true revoke.
  app.post(
    '/unfile',
    adminOnly,
    zValidator('json', z.object({ agent_id: z.string(), file_id: z.string().min(1) })),
    async (c) => {
      const { agent_id, file_id } = c.req.valid('json');
      const conn = await googleConn(db, agent_id, c.get('workspaceId'));
      if (!conn) return c.json({ error: 'connect Google first' }, 404);
      const creds = connectionCreds(conn);
      const excl = excludedFiles(conn);
      excl.add(file_id);
      creds.excluded = [...excl].join(',');
      await db
        .update(agentConnections)
        .set({ credentialsEnc: encryptSecret(JSON.stringify(creds)), updatedAt: new Date() })
        .where(eq(agentConnections.id, conn.id));
      return c.json({ ok: true });
    },
  );

  // Create a new Google file (sheet/doc/slide) for this connection —
  // app-created files are visible to tools under drive.file automatically.
  app.post(
    '/create-file',
    adminOnly,
    zValidator('json', z.object({ agent_id: z.string(), mime_type: z.string(), title: z.string().min(1) })),
    async (c) => {
      const { agent_id, mime_type, title } = c.req.valid('json');
      const conn = await googleConn(db, agent_id, c.get('workspaceId'));
      if (!conn) return c.json({ error: 'connect Google first' }, 404);
      if (!mime_type.startsWith('application/vnd.google-apps.'))
        return c.json({ error: 'unsupported file type' }, 400);
      const token = await connectionToken(db, conn);
      const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, mimeType: mime_type }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return c.json({ error: `drive create failed (${res.status})` }, 502);
      return c.json({ file: await res.json() });
    },
  );

  return app;
}

/** File ids the operator unshared — stored on the connection creds. */
function excludedFiles(conn: typeof agentConnections.$inferSelect): Set<string> {
  const raw = connectionCreds(conn).excluded ?? '';
  return new Set(raw.split(',').filter(Boolean));
}

/** The agent's 'google' agent_connection row, if connected. */
async function googleConn(db: Db, agentId: string, workspaceId: string) {
  const [conn] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.agentId, agentId),
        eq(agentConnections.workspaceId, workspaceId),
        eq(agentConnections.provider, 'google'),
      ),
    )
    .limit(1);
  return conn ?? null;
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

    // Install only the template the user clicked — other Google cards add
    // their tools later without re-running OAuth (connection already exists).
    const tpl = TOOL_TEMPLATES.find((t) => t.id === intent.t) ?? TOOL_TEMPLATES.find((t) => t.id === 'google-sheets');
    if (tpl) {
      const cfg = (agent.config ?? {}) as AgentConfig;
      const names = new Set(tpl.tools.map((t) => t.name));
      const stamped = tpl.tools.map((t) => ({ ...t, template: tpl.id }));
      const tools = [...(cfg.tools ?? []).filter((t) => !names.has(t.name)), ...stamped];
      await db.update(agents).set({ config: { ...cfg, tools } }).where(eq(agents.id, agent.id));
    }

    return done(label, true);
  });

  return app;
}
