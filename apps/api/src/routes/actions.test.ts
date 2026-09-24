import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  conversations,
  memberships,
  pendingActions,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken, hashPassword } from '../lib/crypto.js';
import { actionRoutes } from './actions.js';

let app: Hono;
let db: Db;
let cookie: string;
let agent: typeof agents.$inferSelect;
let conv: typeof conversations.$inferSelect;

async function seedSession(userId: string) {
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  return `janis_session=${token}`;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/actions', actionRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const [other] = await db.insert(workspaces).values({ name: 'Other' }).returning();
  const [user] = await db
    .insert(users)
    .values({ email: 'op@x.c', name: 'Op', passwordHash: await hashPassword('password123') })
    .returning();
  const [outsider] = await db
    .insert(users)
    .values({ email: 'out@x.c', name: 'Out', passwordHash: await hashPassword('password123') })
    .returning();
  await db.insert(memberships).values([
    { userId: user.id, workspaceId: ws.id, role: 'member', acceptedAt: new Date() },
    { userId: outsider.id, workspaceId: other.id, role: 'admin', acceptedAt: new Date() },
  ]);
  cookie = await seedSession(user.id);
  outsiderCookie = await seedSession(outsider.id);

  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning()
  )[0];
  [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'webchat:vis_x' })
    .returning();
});

let outsiderCookie: string;

const decide = (id: string, decision: string, c?: string) =>
  app.request(`/api/actions/${id}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
    body: JSON.stringify({ decision }),
  });

const makeAction = async (tool: Record<string, unknown>) =>
  (
    await db
      .insert(pendingActions)
      .values({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: conv.id,
        toolName: String(tool.name),
        tool,
        args: { amount: '25' },
      })
      .returning()
  )[0];

const GATED = {
  name: 'propose_refund',
  description: 'refund',
  method: 'POST',
  url: 'https://api.test/refund',
  approval: true,
};

describe('action decide route', () => {
  it('rejects unauthenticated requests', async () => {
    const action = await makeAction(GATED);
    expect((await decide(action.id, 'denied')).status).toBe(401);
  });

  it('404s for a member of a different workspace', async () => {
    const action = await makeAction(GATED);
    expect((await decide(action.id, 'denied', outsiderCookie)).status).toBe(404);
  });

  it('denies: marks the action without calling the tool', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const action = await makeAction(GATED);
    const res = await decide(action.id, 'denied', cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('approves: executes the stored tool and records the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })),
    );
    const action = await makeAction(GATED);
    const res = await decide(action.id, 'approved', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.test/refund'),
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('409s when the action was already decided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const action = await makeAction(GATED);
    expect((await decide(action.id, 'denied', cookie)).status).toBe(200);
    expect((await decide(action.id, 'approved', cookie)).status).toBe(409);
    vi.unstubAllGlobals();
  });
});
