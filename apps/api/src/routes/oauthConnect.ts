import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { env, requestOrigin, requestWebOrigin } from '../env.js';
import { AgentConfig } from '@janis/shared';
import { agentConnections, agents } from '../db/schema.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { connectionToken, type ConnectionCreds } from '../lib/connections.js';
import { encryptSecret } from '../lib/secrets.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';

// Generic authorization-code connect for the *-connect tool templates —
// one pair of routes serves every provider: /api/oauth/:provider/connect
// bounces an admin through provider consent, /oauth/:provider/callback
// exchanges the code, stores the refresh token (+ any host fields the API
// base needs — Jira's cloud_id, Salesforce's instance_url) on
// agent_connections, installs the template's tools, and redirects back.
// Per-provider quirks live in the config table below — Calendly/Google
// predate it and keep their own routes.
const STATE_TTL_MS = 15 * 60 * 1000;

interface OAuthProvider {
  /** connection.provider + the CONN_<P>_TOKEN secret prefix. */
  id: string;
  /** The *-connect tool template whose tools install on connect. */
  templateId: string;
  /** Janis-owned OAuth app creds — ''/'' until the env pair lands. */
  envCreds: () => { clientId: string; clientSecret: string };
  /** Consent URL — provider-specific params (audience, scope, actor). */
  authorizeUrl: (p: { clientId: string; redirectUri: string; state: string }) => string;
  tokenUrl: string;
  /** Token exchange posts JSON instead of form-encoded (Atlassian). */
  tokenJson?: boolean;
  /** App creds in the POST body vs HTTP Basic — most providers take body. */
  credsIn: 'body' | 'basic';
  /** PKCE — the provider requires code_challenge at authorize time
   *  (Salesforce ECAs enforce it) and the verifier at exchange. */
  pkce?: boolean;
  /** Extra creds fields gathered with the fresh token — Jira's cloud_id,
   *  Salesforce's instance_url — exposed to tools via exposeSecrets. */
  extraCreds?: (
    accessToken: string,
    tok: Record<string, unknown>,
  ) => Promise<Record<string, string>>;
  /** Connection label for the card — site/workspace/portal name. */
  label?: (tok: Record<string, unknown>, extra: Record<string, string>) => string;
}

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  jira: {
    id: 'jira',
    templateId: 'jira-connect',
    envCreds: () => ({ clientId: env.jiraClientId, clientSecret: env.jiraClientSecret }),
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://auth.atlassian.com/authorize?${new URLSearchParams({
        audience: 'api.atlassian.com',
        client_id: clientId,
        scope: 'read:jira-work write:jira-work offline_access',
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        prompt: 'consent',
      })}`,
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    tokenJson: true,
    credsIn: 'body',
    // 3LO tokens don't call the site directly — tools go through
    // api.atlassian.com/ex/jira/<cloudId>, and the id comes from
    // accessible-resources. With several sites granted we take the first;
    // reconnect on a single-site account to retarget.
    extraCreds: async (accessToken) => {
      const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const sites = (await res.json().catch(() => [])) as {
        id?: string;
        name?: string;
        url?: string;
      }[];
      const site = sites[0];
      if (!site?.id) throw new Error('the account grants no Jira site access');
      return { cloud_id: site.id, site_name: site.name ?? site.url ?? 'Jira site' };
    },
    label: (_t, extra) => extra.site_name || 'Jira site',
  },
  linear: {
    id: 'linear',
    templateId: 'linear-connect',
    envCreds: () => ({ clientId: env.linearClientId, clientSecret: env.linearClientSecret }),
    // actor=app — issues/comments post as the app, not the operator who
    // clicked Connect. prompt=consent shows the workspace picker every
    // time so one account can connect several workspaces.
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://linear.app/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'read,issues:create,comments:create',
        state,
        actor: 'app',
        prompt: 'consent',
      })}`,
    tokenUrl: 'https://api.linear.app/oauth/token',
    credsIn: 'body',
    extraCreds: async (accessToken) => {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{organization{name}}' }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json().catch(() => null)) as {
        data?: { organization?: { name?: string } };
      } | null;
      return { site_name: d?.data?.organization?.name ?? 'Linear workspace' };
    },
    label: (_t, extra) => extra.site_name || 'Linear workspace',
  },
  hubspot: {
    id: 'hubspot',
    templateId: 'hubspot-connect',
    envCreds: () => ({ clientId: env.hubspotClientId, clientSecret: env.hubspotClientSecret }),
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://app.hubspot.com/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope:
          'oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.tickets.read crm.objects.tickets.write crm.schemas.tickets.read crm.schemas.tickets.write',
        state,
      })}`,
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    credsIn: 'body',
    extraCreds: async (accessToken) => {
      const res = await fetch('https://api.hubapi.com/account-info/v3/details', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json().catch(() => null)) as { portalId?: number } | null;
      return { site_name: d?.portalId ? `portal ${d.portalId}` : 'HubSpot account' };
    },
    label: (_t, extra) => extra.site_name || 'HubSpot account',
  },
  salesforce: {
    id: 'salesforce',
    templateId: 'salesforce-connect',
    envCreds: () => ({
      clientId: env.salesforceClientId,
      clientSecret: env.salesforceClientSecret,
    }),
    // api = REST access; refresh_token = offline mints. One connected app
    // serves every org — login.salesforce.com redirects to theirs and the
    // token response's instance_url is the API host (exposed to tools as
    // CONN_SALESFORCE_INSTANCE_URL).
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://login.salesforce.com/services/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'api refresh_token',
        state,
        prompt: 'consent',
      })}`,
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    credsIn: 'body',
    // External Client Apps default to requiring PKCE on the auth-code flow.
    pkce: true,
    extraCreds: async (_at, tok) => ({
      instance_url: typeof tok.instance_url === 'string' ? tok.instance_url : '',
    }),
    label: (tok) =>
      typeof tok.instance_url === 'string' && tok.instance_url
        ? tok.instance_url.replace(/^https?:\/\//, '')
        : 'Salesforce org',
  },
};

/** Which workspace/agent the connection installs onto — signed, stateless. */
interface Intent {
  w: string;
  a: string;
  x: number;
  /** PKCE code_verifier — rides the signed state so the callback can
   *  complete the exchange without server-side storage. */
  v?: string;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
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

/** Console endpoints mounted at /api/oauth — session auth + admin. */
export function oauthApiRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/:provider/connect', adminOnly, async (c) => {
    const spec = OAUTH_PROVIDERS[c.req.param('provider')];
    const agentId = c.req.query('agent_id') ?? '';
    const fail = (msg: string) =>
      c.redirect(
        `${requestWebOrigin(c)}/agents/${agentId}/integrations?${spec?.id ?? 'oauth'}_error=${encodeURIComponent(msg)}`,
      );
    if (!spec) return fail('unknown OAuth provider');
    const { clientId, clientSecret } = spec.envCreds();
    if (!clientId || !clientSecret) {
      return fail(`${spec.id} OAuth is not configured on this Janis deployment`);
    }
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) {
      return fail(`pick the agent this ${spec.id} account should serve`);
    }
    const pkce = spec.pkce ? pkcePair() : null;
    const state = signIntent({
      w: c.get('workspaceId'),
      a: agentId,
      x: Date.now() + STATE_TTL_MS,
      v: pkce?.verifier,
    });
    let url = spec.authorizeUrl({
      clientId,
      redirectUri: `${requestOrigin(c)}/oauth/${spec.id}/callback`,
      state,
    });
    if (pkce) {
      url += `&code_challenge=${pkce.challenge}&code_challenge_method=S256`;
    }
    return c.redirect(url);
  });

  return app;
}

/** Public endpoints mounted at /oauth — the signed state IS the auth. */
export function oauthPublicRoutes(db: Db) {
  const app = new Hono();

  app.get('/:provider/callback', async (c) => {
    const spec = OAUTH_PROVIDERS[c.req.param('provider')];
    const intent = verifyIntent(c.req.query('state') ?? '');
    if (!spec || !intent) {
      return c.redirect(
        `${requestWebOrigin(c)}/agents?oauth_error=${encodeURIComponent('invalid OAuth state')}`,
      );
    }
    const done = (msg: string, ok = false) =>
      c.redirect(
        `${requestWebOrigin(c)}/agents/${intent.a}/integrations?${ok ? `${spec.id}_connect` : `${spec.id}_error`}=${encodeURIComponent(msg)}`,
      );

    const code = c.req.query('code');
    if (!code) {
      return done(c.req.query('error_description') ?? c.req.query('error') ?? 'authorization denied');
    }

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, intent.a), eq(agents.workspaceId, intent.w)))
      .limit(1);
    if (!agent) return done('agent not found');

    const { clientId, clientSecret } = spec.envCreds();
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${requestOrigin(c)}/oauth/${spec.id}/callback`,
      ...(spec.credsIn === 'body'
        ? { client_id: clientId, client_secret: clientSecret }
        : {}),
      ...(spec.pkce && intent.v ? { code_verifier: intent.v } : {}),
    };
    const headers: Record<string, string> = {
      'content-type': spec.tokenJson ? 'application/json' : 'application/x-www-form-urlencoded',
    };
    if (spec.credsIn === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    }
    const tokenRes = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers,
      body: spec.tokenJson ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json().catch(() => null)) as Record<string, unknown> | null;
    const accessToken = typeof tok?.access_token === 'string' ? tok.access_token : '';
    const refreshToken = typeof tok?.refresh_token === 'string' ? tok.refresh_token : '';
    if (!tokenRes.ok || !tok || !accessToken || !refreshToken) {
      return done(
        String(tok?.error_description ?? tok?.error ?? 'token exchange failed'),
      );
    }

    let extra: Record<string, string> = {};
    try {
      extra = (await spec.extraCreds?.(accessToken, tok)) ?? {};
    } catch (err) {
      return done(`connected but setup failed: ${(err as Error).message}`);
    }
    const label = spec.label?.(tok, extra) || spec.id;
    const creds: ConnectionCreds = { refresh_token: refreshToken, ...extra };
    const expiresAt =
      typeof tok.expires_in === 'number'
        ? new Date(Date.now() + tok.expires_in * 1000)
        : null;
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: intent.w,
        provider: spec.id,
        label,
        credentialsEnc: encryptSecret(JSON.stringify(creds)),
        accessTokenEnc: encryptSecret(accessToken),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [agentConnections.agentId, agentConnections.provider],
        set: {
          label,
          credentialsEnc: encryptSecret(JSON.stringify(creds)),
          accessTokenEnc: encryptSecret(accessToken),
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
    const tpl = TOOL_TEMPLATES.find((t) => t.id === spec.templateId);
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
