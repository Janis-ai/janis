import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agentMembers,
  agents,
  memberships,
  savedReplies,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { env } from '../env.js';
import { llmFor } from '../lib/llm.js';
import { agentRoutes } from './agents.js';
import { savedReplyRoutes } from './savedReplies.js';
import { workspaceRoutes } from './workspace.js';

let app: Hono;
let db: Db;
let wsId: string;
let agentA: string;
let agentB: string;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let scopedCookie: string;
let scopedId: string;

/** Session without a workspace pin — sessionAuth resolves it (membership
 *  fallback, else the agent_members scope). */
const sessionFor = async (userId: string) => {
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId, expiresAt: new Date(Date.now() + 86400_000) });
  return `${SESSION_COOKIE}=${token}`;
};

const makeUser = async (email: string, workspaceId?: string, role = 'member') => {
  const [u] = await db.insert(users).values({ email, name: email }).returning();
  if (workspaceId) {
    await db
      .insert(memberships)
      .values({ userId: u.id, workspaceId, role, acceptedAt: new Date() });
  }
  return { user: u, cookie: await sessionFor(u.id) };
};

const addAgent = (cookie: string, name: string) =>
  app
    .request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name }),
    })
    .then((r) => r.json());

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/api/agents', agentRoutes(db))
    .route('/api/saved-replies', savedReplyRoutes(db))
    .route('/api/workspace', workspaceRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'WS', plan: 'internal' }).returning();
  wsId = ws.id;
  adminCookie = (await makeUser('admin@x.test', wsId, 'admin')).cookie;
  const member = await makeUser('member@x.test', wsId, 'member');
  memberCookie = member.cookie;
  memberId = member.user.id;
  // Agent-scoped user: no membership at all — access comes from agent_members.
  const scoped = await makeUser('scoped@x.test');
  scopedCookie = scoped.cookie;
  scopedId = scoped.user.id;

  agentA = (await addAgent(adminCookie, 'Agent A')).agent.id;
  agentB = (await addAgent(adminCookie, 'Agent B')).agent.id;
});

const grant = (userId: string, agentId: string, role: 'admin' | 'member' | null) =>
  db.insert(agentMembers).values({ userId, agentId, role, acceptedAt: new Date() });

describe('agent-scoped access', () => {
  it('scoped user sees only their granted agent', async () => {
    await grant(scopedId, agentA, 'member');
    const res = await app.request('/api/agents', { headers: { cookie: scopedCookie } });
    expect(res.status).toBe(200);
    const { agents: list } = await res.json();
    expect(list.map((a: { id: string }) => a.id)).toEqual([agentA]);
  });

  it('scoped user gets 404 on an agent outside their scope', async () => {
    const res = await app.request(`/api/agents/${agentB}/members`, {
      headers: { cookie: scopedCookie },
    });
    expect(res.status).toBe(404);
  });

  it('scoped member cannot PATCH their agent (not agent admin)', async () => {
    const res = await app.request(`/api/agents/${agentA}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: scopedCookie },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(403);
  });

  it('workspace member promoted to agent admin can PATCH', async () => {
    await grant(memberId, agentA, 'admin');
    const res = await app.request(`/api/agents/${agentA}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ name: 'A Renamed' }),
    });
    expect(res.status).toBe(200);
  });

  it('member without an override stays member (403)', async () => {
    const res = await app.request(`/api/agents/${agentB}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ name: 'B Renamed' }),
    });
    expect(res.status).toBe(403);
  });

  it('workspace admin demoted on an agent loses PATCH there', async () => {
    const [adminUser] = await db.select().from(users).where(eq(users.email, 'admin@x.test'));
    await grant(adminUser.id, agentB, 'member');
    const res = await app.request(`/api/agents/${agentB}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'B Renamed' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('workspace LLM default', () => {
  it('PATCH /api/workspace stores the default; agents inherit', async () => {
    const res = await app.request('/api/workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ llm_config: { provider: 'janis', model: 'gpt-6-sol' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace.llm_config.model).toBe('gpt-6-sol');
    // write-only: never the raw key
    expect(body.workspace.llm_config.api_key).toBeUndefined();
  });

  it('llmFor resolves agent override → workspace default → env', async () => {
    const [a] = await db.select().from(agents).where(eq(agents.id, agentA));
    // agent has no override → workspace model
    const inherited = await llmFor(db, a);
    expect(inherited.model).toBe('gpt-6-sol');
    expect(inherited.byok).toBe(false);
    // agent override wins
    const withOverride = await llmFor(db, {
      ...a,
      config: { ...((a.config as object) ?? {}), llm: { provider: 'janis', model: 'gpt-6-luna' } },
    });
    expect(withOverride.model).toBe('gpt-6-luna');
    // no workspace default → env
    await db.update(workspaces).set({ llmConfig: {} }).where(eq(workspaces.id, wsId));
    const bare = await llmFor(db, a);
    expect(bare.model).toBe(env.llmModel);
  });

  it('free plan cannot move the workspace metered default (402)', async () => {
    const [free] = await db.insert(workspaces).values({ name: 'Free WS', plan: 'free' }).returning();
    const freeCookie = (await makeUser('free@x.test', free.id, 'admin')).cookie;
    const res = await app.request('/api/workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({ llm_config: { provider: 'janis', model: 'claude-expensive' } }),
    });
    expect(res.status).toBe(402);
    // BYOK workspace default stays free
    const byok = await app.request('/api/workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: freeCookie },
      body: JSON.stringify({
        llm_config: { provider: 'openrouter', model: 'x', api_key: 'sk-x', base_url: 'https://openrouter.ai/api/v1' },
      }),
    });
    expect(byok.status).toBe(200);
  });
});

describe('agent saved replies', () => {
  it('merges workspace + agent replies; bare list stays workspace-only', async () => {
    await db.insert(savedReplies).values({ workspaceId: wsId, title: 'ws', body: 'ws reply' });
    await db
      .insert(savedReplies)
      .values({ workspaceId: wsId, agentId: agentA, title: 'agent', body: 'agent reply' });
    const merged = await app.request(`/api/saved-replies?agent_id=${agentA}`, {
      headers: { cookie: memberCookie },
    });
    const mergedTitles = (await merged.json()).saved_replies.map((r: { title: string }) => r.title);
    expect(mergedTitles).toContain('ws');
    expect(mergedTitles).toContain('agent');
    const bare = await app.request('/api/saved-replies', { headers: { cookie: memberCookie } });
    const bareTitles = (await bare.json()).saved_replies.map((r: { title: string }) => r.title);
    expect(bareTitles).toContain('ws');
    expect(bareTitles).not.toContain('agent');
  });

  it('scoped user cannot add or delete workspace replies', async () => {
    const post = await app.request('/api/saved-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: scopedCookie },
      body: JSON.stringify({ title: 'nope', body: 'nope' }),
    });
    expect(post.status).toBe(403);
    const ws = await db.select().from(savedReplies).where(eq(savedReplies.title, 'ws'));
    const del = await app.request(`/api/saved-replies/${ws[0].id}`, {
      method: 'DELETE',
      headers: { cookie: scopedCookie },
    });
    expect(del.status).toBe(403);
    // but can add one to their agent
    const ok = await app.request('/api/saved-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: scopedCookie },
      body: JSON.stringify({ title: 'mine', body: 'agent reply', agent_id: agentA }),
    });
    expect(ok.status).toBe(201);
  });
});
