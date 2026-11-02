import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agentConnections, agents, workspaces } from '../db/schema.js';
import { connectionCreds, connectionSecrets, connectionToken } from './connections.js';
import { encryptSecret } from './secrets.js';

let db: Db;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
});

describe('connectionToken — refresh providers (calendly)', () => {
  it('mints via grant_type=refresh_token with Basic auth and persists rotation', async () => {
    const [ws] = await db.insert(workspaces).values({ name: 'W', plan: 'pro' }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'A', apiKeyHash: 'h', apiKeyPreview: 'p', hosted: true })
      .returning();
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: ws.id,
        provider: 'calendly',
        label: 'acct',
        credentialsEnc: encryptSecret(JSON.stringify({ refresh_token: 'r1' })),
        expiresAt: new Date(Date.now() - 60_000), // expired → forces a mint
      })
      .returning();

    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ access_token: 'a1', expires_in: 7200, refresh_token: 'r2' }),
          { status: 200 },
        );
      }),
    );
    try {
      expect(await connectionToken(db, conn)).toBe('a1');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://auth.calendly.com/oauth/token');
      const body = String(calls[0].init?.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=r1');
      expect(body).not.toContain('client_id');
      const auth = (calls[0].init?.headers as Record<string, string>).authorization;
      expect(auth).toMatch(/^Basic /);

      // Calendly rotates the refresh token — the stored creds now hold r2.
      const [after] = await db
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.id, conn.id));
      expect(connectionCreds(after).refresh_token).toBe('r2');

      // Within expiry → the cached access token returns with no new call.
      expect(await connectionToken(db, after)).toBe('a1');
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails cleanly with no refresh token and no client credentials', async () => {
    const [ws] = await db.select().from(workspaces).limit(1);
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'B', apiKeyHash: 'h2', apiKeyPreview: 'p2', hosted: true })
      .returning();
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: ws.id,
        provider: 'calendly',
        credentialsEnc: encryptSecret(JSON.stringify({})),
      })
      .returning();
    await expect(connectionToken(db, conn)).rejects.toThrow('missing client credentials');
  });
});

describe('connectionToken — oauth-connect providers', () => {
  let seedN = 0;
  const seed = async (provider: string, creds: object) => {
    const n = ++seedN;
    const [ws] = await db.insert(workspaces).values({ name: `W-${provider}-${n}` }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'A', apiKeyHash: `h-${provider}-${n}`, apiKeyPreview: 'p' })
      .returning();
    const [conn] = await db
      .insert(agentConnections)
      .values({
        agentId: agent.id,
        workspaceId: ws.id,
        provider,
        credentialsEnc: encryptSecret(JSON.stringify(creds)),
        expiresAt: new Date(Date.now() - 60_000), // expired → forces a mint
      })
      .returning();
    return { ws, agent, conn };
  };
  const capture = () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ access_token: 'a1', expires_in: 3600, refresh_token: 'r2' }),
          { status: 200 },
        );
      }),
    );
    return calls;
  };

  it('jira mints a JSON refresh grant with creds in the body (Atlassian)', async () => {
    const { conn } = await seed('jira', { refresh_token: 'rj', cloud_id: 'cloud-9' });
    const calls = capture();
    try {
      await connectionToken(db, conn);
      expect(calls[0].url).toBe('https://auth.atlassian.com/oauth/token');
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers.authorization).toBeUndefined();
      expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'rj',
      });
      // rotated refresh persists
      const [after] = await db
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.id, conn.id));
      expect(connectionCreds(after).refresh_token).toBe('r2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('oauth salesforce rows mint on login.salesforce.com; BYO rows keep the instance host', async () => {
    const { conn: oauth } = await seed('salesforce', {
      refresh_token: 'rsf',
      instance_url: 'https://acme.my.salesforce.com',
    });
    const { conn: byo } = await seed('salesforce', {
      host: 'acme.my.salesforce.com',
      client_id: 'cid',
      client_secret: 'cs',
    });
    const calls = capture();
    try {
      await connectionToken(db, oauth);
      await connectionToken(db, byo);
      expect(calls[0].url).toBe('https://login.salesforce.com/services/oauth2/token');
      expect(String(calls[0].init?.body)).toContain('grant_type=refresh_token');
      expect(calls[1].url).toBe('https://acme.my.salesforce.com/services/oauth2/token');
      expect(String(calls[1].init?.body)).toContain('grant_type=client_credentials');
      expect(String(calls[1].init?.body)).toContain('client_id=cid');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('connectionSecrets exposes allowlisted creds fields as CONN_<P>_<FIELD>', async () => {
    const { agent } = await seed('jira', { refresh_token: 'rj', cloud_id: 'cloud-9' });
    const { agent: sfAgent } = await seed('salesforce', {
      refresh_token: 'rsf',
      instance_url: 'https://acme.my.salesforce.com',
    });
    capture();
    try {
      const secrets = await connectionSecrets(db, agent.id);
      expect(secrets.CONN_JIRA_TOKEN).toBe('a1');
      expect(secrets.CONN_JIRA_CLOUD_ID).toBe('cloud-9');
      const sf = await connectionSecrets(db, sfAgent.id);
      // tools wrap exposed fields in https:// themselves — a stored full
      // URL would double the scheme and every call would fetch-fail
      expect(sf.CONN_SALESFORCE_INSTANCE_URL).toBe('acme.my.salesforce.com');
      // and nothing else leaks — refresh_token stays inside the vault
      expect(Object.keys(sf)).not.toContain('CONN_SALESFORCE_REFRESH_TOKEN');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
