import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentConnections } from '../db/schema.js';
import { env } from '../env.js';
import { decryptSecret, encryptSecret } from './secrets.js';

type ConnRow = typeof agentConnections.$inferSelect;

/** Stored credential payload per provider — host is the instance/subdomain. */
export interface ConnectionCreds {
  host?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  /** Authorization-code providers (Calendly) — rotating; persisted on mint. */
  refresh_token?: string;
  [k: string]: string | undefined;
}

interface ProviderSpec {
  /** OAuth2 token endpoint for this connection's host. */
  tokenUrl: (c: ConnectionCreds) => string;
  /** Optional scope sent with the grant. */
  scope?: string;
  /** Extra form fields beyond grant_type/client_id/client_secret/scope. */
  extra?: (c: ConnectionCreds) => Record<string, string>;
  /** Authorization-code connections carry a refresh_token in creds instead
   *  of client credentials — mint uses grant_type=refresh_token with this
   *  Basic-auth pair (the Janis app's client id/secret), then persists the
   *  rotated refresh token providers hand back. */
  refreshBasic?: () => [string, string];
  /** Same refresh grant but client_id/secret travel in the POST body —
   *  Atlassian/HubSpot/Salesforce want them there, not Basic. */
  refreshBody?: () => { client_id: string; client_secret: string };
  /** Token endpoint speaks JSON instead of form-encoded (Atlassian). */
  jsonToken?: boolean;
  /** Token endpoint wants Accept: application/json or it answers
   *  form-encoded (GitHub). */
  acceptJson?: boolean;
  /** Access tokens don't expire and there's no refresh grant — the row's
   *  stored token serves until revoked (GitHub OAuth Apps). If the app
   *  does hand back refresh_token + expires_in (GitHub-App-style expiring
   *  user tokens), the normal refresh path mints instead. */
  staticToken?: boolean;
  /** Plain-string creds fields also exposed as CONN_<P>_<FIELD> secrets —
   *  tool URLs need them (Jira's cloud_id, Salesforce's instance_url).
   *  NEVER list client_secret/refresh_token — they'd leak into tool
   *  traffic. */
  exposeSecrets?: string[];
}

const PROVIDERS: Record<string, ProviderSpec> = {
  'zendesk-oauth': {
    tokenUrl: (c) => `https://${c.host}/oauth/token`,
    scope: 'read write',
    extra: () => ({ grant_type: 'client_credentials' }),
  },
  salesforce: {
    // OAuth-connect rows carry a refresh_token + instance_url (minted on
    // login.salesforce.com); BYO rows carry host + client credentials.
    tokenUrl: (c) =>
      c.refresh_token
        ? 'https://login.salesforce.com/services/oauth2/token'
        : `https://${c.host}/services/oauth2/token`,
    extra: () => ({ grant_type: 'client_credentials' }),
    refreshBody: () => ({
      client_id: env.salesforceClientId,
      client_secret: env.salesforceClientSecret,
    }),
    exposeSecrets: ['instance_url'],
  },
  // Janis-owned OAuth apps — routes/oauthConnect.ts runs the
  // authorization-code flow; the connection stores the granted refresh
  // token plus whatever host fields the API base needs.
  jira: {
    tokenUrl: () => 'https://auth.atlassian.com/oauth/token',
    refreshBody: () => ({
      client_id: env.jiraClientId,
      client_secret: env.jiraClientSecret,
    }),
    jsonToken: true,
    exposeSecrets: ['cloud_id'],
  },
  confluence: {
    tokenUrl: () => 'https://auth.atlassian.com/oauth/token',
    refreshBody: () => ({
      client_id: env.jiraClientId,
      client_secret: env.jiraClientSecret,
    }),
    jsonToken: true,
    exposeSecrets: ['cloud_id'],
  },
  linear: {
    tokenUrl: () => 'https://api.linear.app/oauth/token',
    refreshBasic: () => [env.linearClientId, env.linearClientSecret],
  },
  hubspot: {
    tokenUrl: () => 'https://api.hubapi.com/oauth/v1/token',
    refreshBody: () => ({
      client_id: env.hubspotClientId,
      client_secret: env.hubspotClientSecret,
    }),
  },
  // Janis-owned OAuth App — the exchange hands back a non-expiring access
  // token with no refresh_token, so the stored token itself serves. If the
  // app is a GitHub App with expiring user tokens, refresh_token comes
  // back too and the refreshBody grant mints here.
  github: {
    tokenUrl: () => 'https://github.com/login/oauth/access_token',
    refreshBody: () => ({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
    }),
    acceptJson: true,
    staticToken: true,
  },
  // Janis-owned OAuth app (developer.calendly.com) — the connection stores
  // only the visitor-granted refresh token; access tokens last ~2h.
  calendly: {
    tokenUrl: () => 'https://auth.calendly.com/oauth/token',
    refreshBasic: () => [env.calendlyClientId, env.calendlyClientSecret],
  },
  // Janis-owned Google OAuth app — same client as sign-in/Gmail. The
  // connection stores the granted refresh token; access tokens last 1h and
  // Google accepts HTTP Basic client auth on the token endpoint.
  google: {
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    refreshBasic: () => [env.googleClientId, env.googleClientSecret],
  },
};

/** Secret placeholder tools reference — e.g. 'zendesk-oauth' → CONN_ZENDESK_OAUTH_TOKEN. */
export function connectionSecretName(provider: string): string {
  return `CONN_${provider.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_TOKEN`;
}

export function connectionCreds(conn: ConnRow): ConnectionCreds {
  try {
    return JSON.parse(decryptSecret(conn.credentialsEnc)) as ConnectionCreds;
  } catch {
    return {};
  }
}

/** Mint a fresh token and persist it on the row — client_credentials for
 *  BYO-app providers, refresh_token (Basic-auth, rotating) for Janis-owned
 *  OAuth apps like Calendly. */
async function mint(db: Db, conn: ConnRow, spec: ProviderSpec): Promise<string> {
  const creds = connectionCreds(conn);
  const refresh = (spec.refreshBasic || spec.refreshBody) && creds.refresh_token;
  if (!refresh && (!creds.client_id || !creds.client_secret)) {
    throw new Error('connection is missing client credentials');
  }
  const fields = refresh
    ? {
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token!,
        // Body-credential providers (Atlassian/HubSpot/Salesforce) want
        // the app pair in the POST body; Basic providers get it in the
        // Authorization header instead.
        ...(spec.refreshBody ? spec.refreshBody() : {}),
      }
    : {
        grant_type: 'client_credentials',
        client_id: creds.client_id!,
        client_secret: creds.client_secret!,
        ...(spec.scope ?? creds.scope ? { scope: spec.scope ?? creds.scope! } : {}),
        ...(spec.extra?.(creds) ?? {}),
      };
  const headers: Record<string, string> = spec.jsonToken
    ? { 'content-type': 'application/json' }
    : { 'content-type': 'application/x-www-form-urlencoded' };
  if (spec.acceptJson) headers.accept = 'application/json';
  if (refresh && spec.refreshBasic) {
    const [id, secret] = spec.refreshBasic();
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }
  const res = await fetch(spec.tokenUrl(creds), {
    method: 'POST',
    headers,
    body: spec.jsonToken ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `token request failed (${res.status})`);
  }
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null; // providers without expiry: refresh on 401-style failures is future work
  await db
    .update(agentConnections)
    .set({
      accessTokenEnc: encryptSecret(data.access_token),
      expiresAt,
      // Rotating refresh tokens (Calendly) — the old one dies on use.
      ...(data.refresh_token
        ? {
            credentialsEnc: encryptSecret(
              JSON.stringify({ ...creds, refresh_token: data.refresh_token }),
            ),
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentConnections.id, conn.id));
  return data.access_token;
}

/** Valid access token for a connection row — decrypts the cache or mints. */
export async function connectionToken(db: Db, conn: ConnRow): Promise<string> {
  const spec = PROVIDERS[conn.provider];
  if (!spec) throw new Error(`unknown connection provider: ${conn.provider}`);
  // refresh a minute early so in-flight tool calls never see a stale token
  if (conn.accessTokenEnc) {
    if (conn.expiresAt && conn.expiresAt.getTime() > Date.now() + 60_000) {
      return decryptSecret(conn.accessTokenEnc);
    }
    // Non-expiring access tokens (GitHub OAuth Apps) carry no expiry and
    // nothing to mint with — the stored token serves until revoked.
    if (!conn.expiresAt && spec.staticToken) {
      return decryptSecret(conn.accessTokenEnc);
    }
  }
  return mint(db, conn, spec);
}

/**
 * Access tokens for every connection on this agent, keyed for the
 * {{secrets.*}} template namespace. Minted/refreshed per agent run — runs
 * are short, so a token minted here stays valid for the whole run.
 */
export async function connectionSecrets(db: Db, agentId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(agentConnections).where(eq(agentConnections.agentId, agentId));
  const map: Record<string, string> = {};
  for (const conn of rows) {
    try {
      map[connectionSecretName(conn.provider)] = await connectionToken(db, conn);
      const spec = PROVIDERS[conn.provider];
      if (spec?.exposeSecrets?.length) {
        const creds = connectionCreds(conn);
        const base = connectionSecretName(conn.provider).slice(0, -'_TOKEN'.length);
        for (const f of spec.exposeSecrets) {
          const v = creds[f];
          if (v) map[`${base}_${f.toUpperCase()}`] = v;
        }
      }
    } catch {
      // leave the placeholder unresolved — the tool call fails with a clear
      // 'unknown secret' error rather than silently leaking a dead token
    }
  }
  return map;
}
