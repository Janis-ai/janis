import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
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
import { userRoutes } from './users.js';
import { workspaceRoutes } from './workspace.js';

let app: Hono;
let db: Db;
let wsId: string;
let agentA: string;
let agentB: string;
let adminCookie: string;
let adminId: string;
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
    .route('/api/users', userRoutes(db))
    .route('/api/workspace', workspaceRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'WS', plan: 'internal' }).returning();
  wsId = ws.id;
  const admin = await makeUser('admin@x.test', wsId, 'admin');
  adminCookie = admin.cookie;
  adminId = admin.user.id;
  await db.update(workspaces).set({ ownerUserId: adminId }).where(eq(workspaces.id, wsId));
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
    // not the owner — admin@x.test OWNS agentB and owners can't be demoted
    const { user: second, cookie: secondCookie } = await makeUser(
      'admin-b@x.test',
      wsId,
      'admin',
    );
    await grant(second.id, agentB, 'member');
    const res = await app.request(`/api/agents/${agentB}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: secondCookie },
      body: JSON.stringify({ name: 'B Renamed' }),
    });
    expect(res.status).toBe(403);
    // while the owner ignores the same kind of row entirely
    await grant(adminId, agentB, 'member');
    const stillAdmin = await app.request(`/api/agents/${agentB}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'B Renamed' }),
    });
    expect(stillAdmin.status).toBe(200);
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

describe('agent ownership', () => {
  it('the creator is recorded as owner and cannot be demoted/hidden/removed', async () => {
    const list = await app.request('/api/agents', { headers: { cookie: adminCookie } });
    const a = (await list.json()).agents.find((x: { id: string }) => x.id === agentA);
    expect(a.owner_user_id).toBe(adminId);

    for (const role of ['member', 'hidden', null]) {
      const res = await app.request(`/api/agents/${agentA}/members/${adminId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(409);
    }
    const del = await app.request(`/api/agents/${agentA}/members/${adminId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(del.status).toBe(409);
  });

  it('only the owner can transfer ownership', async () => {
    // member is an agent admin on agentA (granted above) but not the owner
    const denied = await app.request(`/api/agents/${agentA}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(denied.status).toBe(403);

    const res = await app.request(`/api/agents/${agentA}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe('owner');
    const [a] = await db.select().from(agents).where(eq(agents.id, agentA));
    expect(a.ownerUserId).toBe(memberId);

    // the former owner is no longer protected — now a plain member row
    const demote = await app.request(`/api/agents/${agentA}/members/${adminId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demote.status).toBe(200);
  });
});

describe('hidden agent members', () => {
  it('hidden removes the agent from a workspace member entirely', async () => {
    const hide = await app.request(`/api/agents/${agentB}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'hidden' }),
    });
    expect(hide.status).toBe(200);

    const list = await app.request('/api/agents', { headers: { cookie: memberCookie } });
    const ids = (await list.json()).agents.map((a: { id: string }) => a.id);
    expect(ids).toContain(agentA);
    expect(ids).not.toContain(agentB);

    const denied = await app.request(`/api/agents/${agentB}/members`, {
      headers: { cookie: memberCookie },
    });
    expect(denied.status).toBe(404);

    // hidden members aren't eligible assignees either
    const users = await app.request(`/api/users?agent_id=${agentB}`, {
      headers: { cookie: adminCookie },
    });
    expect((await users.json()).users.map((u: { id: string }) => u.id)).not.toContain(memberId);

    // un-hide restores access
    const back = await app.request(`/api/agents/${agentB}/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(back.status).toBe(200);
    const relist = await app.request('/api/agents', { headers: { cookie: memberCookie } });
    expect((await relist.json()).agents.map((a: { id: string }) => a.id)).toContain(agentB);
  });

  it('hidden is rejected for agent-only users — remove them instead', async () => {
    const res = await app.request(`/api/agents/${agentA}/members/${scopedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'hidden' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('workspace ownership', () => {
  it('the workspace owner cannot be demoted or removed', async () => {
    const demote = await app.request(`/api/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demote.status).toBe(409);

    const { cookie: otherAdmin } = await makeUser('admin2@x.test', wsId, 'admin');
    const del = await app.request(`/api/users/${adminId}`, {
      method: 'DELETE',
      headers: { cookie: otherAdmin },
    });
    expect(del.status).toBe(409);

    // a non-owner admin cannot transfer ownership
    const steal = await app.request(`/api/users/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: otherAdmin },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(steal.status).toBe(403);
  });

  it('the owner transfers ownership by promoting a member', async () => {
    const res = await app.request(`/api/users/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('owner');

    // transfer auto-promotes the membership to admin
    const [mem] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, memberId), eq(memberships.workspaceId, wsId)));
    expect(mem.role).toBe('admin');

    // the former owner is unprotected now — demotable like any admin
    const demote = await app.request(`/api/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demote.status).toBe(200);

    // members list reports the owner role
    const users = await app.request('/api/users', { headers: { cookie: adminCookie } });
    const list = await users.json();
    expect(list.users.find((u: { id: string }) => u.id === memberId).role).toBe('owner');
    expect(list.users.find((u: { id: string }) => u.id === adminId).role).toBe('member');
  });
});

describe('agent-invite sign-in landing', () => {
  it('a fresh session with no workspace heals onto the invited agent workspace', async () => {
    const { authRoutes } = await import('./auth.js');
    const authApp = new Hono().route('/auth', authRoutes(db));
    // scoped@x.test holds an agent_members grant but zero memberships — the
    // session was issued with no workspace pin (pre-fix behavior)
    const res = await authApp.request('/auth/me', {
      headers: { cookie: scopedCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace?.id).toBe(wsId);
    expect(body.agent_scope?.map((a: { id: string }) => a.id)).toContain(agentA);
    // switcher also exposes the scope-reachable workspace
    expect(body.workspaces.map((w: { id: string }) => w.id)).toContain(wsId);
  });

  it('/auth/switch accepts a workspace reachable only via agent grants', async () => {
    const { authRoutes } = await import('./auth.js');
    const authApp = new Hono().route('/auth', authRoutes(db));
    const res = await authApp.request('/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: scopedCookie },
      body: JSON.stringify({ workspace_id: wsId }),
    });
    expect(res.status).toBe(200);
    // a workspace they hold NO grants on stays closed
    const [otherWs] = await db.insert(workspaces).values({ name: 'Closed' }).returning();
    const denied = await authApp.request('/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: scopedCookie },
      body: JSON.stringify({ workspace_id: otherWs.id }),
    });
    expect(denied.status).toBe(403);
  });

  it('switching to a grant-only workspace sticks — /me reports the scoped view', async () => {
    const { authRoutes } = await import('./auth.js');
    const authApp = new Hono().route('/auth', authRoutes(db));
    // A user with their OWN workspace membership + an agent grant elsewhere —
    // the mookniness case: switch must not snap back to their membership.
    const [ownWs] = await db.insert(workspaces).values({ name: 'OwnWS' }).returning();
    const { user: dual, cookie: dualCookie } = await makeUser('dual@x.test', ownWs.id, 'admin');
    await grant(dual.id, agentB, 'member'); // grant on wsId, member elsewhere

    const sw = await authApp.request('/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: dualCookie },
      body: JSON.stringify({ workspace_id: wsId }),
    });
    expect(sw.status).toBe(200);

    const me = await authApp.request('/auth/me', { headers: { cookie: dualCookie } });
    const body = await me.json();
    expect(body.workspace?.id).toBe(wsId);
    expect(body.agent_scope?.map((a: { id: string }) => a.id)).toEqual([agentB]);

    // API calls against the pinned grant workspace resolve the grant scope —
    // not the user's unrelated membership (sessionAuth snap-back regression)
    const agentsRes = await app.request('/api/agents', {
      headers: { cookie: dualCookie },
    });
    const agentsBody = await agentsRes.json();
    expect(agentsBody.agents.map((a: { id: string }) => a.id)).toEqual([agentB]);

    // and it stays after switching back to their membership workspace
    const back = await authApp.request('/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: dualCookie },
      body: JSON.stringify({ workspace_id: ownWs.id }),
    });
    expect(back.status).toBe(200);
    const me2 = await authApp.request('/auth/me', { headers: { cookie: dualCookie } });
    expect((await me2.json()).workspace?.id).toBe(ownWs.id);
    const back2 = await app.request('/api/agents', { headers: { cookie: dualCookie } });
    expect((await back2.json()).agents).toEqual([]);
  });
});
