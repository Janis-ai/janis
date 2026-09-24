import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentConnections } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secrets.js';

type ConnRow = typeof agentConnections.$inferSelect;

/** Stored credential payload per provider — host is the instance/subdomain. */
export interface ConnectionCreds {
  host?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  [k: string]: string | undefined;
}

interface ProviderSpec {
  /** OAuth2 client_credentials token endpoint for this connection's host. */
  tokenUrl: (c: ConnectionCreds) => string;
  /** Optional scope sent with the grant. */
  scope?: string;
  /** Extra form fields beyond grant_type/client_id/client_secret/scope. */
  extra?: (c: ConnectionCreds) => Record<string, string>;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  'zendesk-oauth': {
    tokenUrl: (c) => `https://${c.host}/oauth/token`,
    scope: 'read write',
    extra: () => ({ grant_type: 'client_credentials' }),
  },
  salesforce: {
    tokenUrl: (c) => `https://${c.host}/services/oauth2/token`,
    extra: () => ({ grant_type: 'client_credentials' }),
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

/** Mint a fresh client_credentials token and persist it on the row. */
async function mint(db: Db, conn: ConnRow, spec: ProviderSpec): Promise<string> {
  const creds = connectionCreds(conn);
  if (!creds.client_id || !creds.client_secret) {
    throw new Error('connection is missing client credentials');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    ...(spec.scope ?? creds.scope ? { scope: spec.scope ?? creds.scope! } : {}),
    ...(spec.extra?.(creds) ?? {}),
  });
  const res = await fetch(spec.tokenUrl(creds), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
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
  if (conn.accessTokenEnc && conn.expiresAt && conn.expiresAt.getTime() > Date.now() + 60_000) {
    return decryptSecret(conn.accessTokenEnc);
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
    } catch {
      // leave the placeholder unresolved — the tool call fails with a clear
      // 'unknown secret' error rather than silently leaking a dead token
    }
  }
  return map;
}
