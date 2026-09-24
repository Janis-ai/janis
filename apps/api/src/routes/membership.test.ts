import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { memberships, sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { agentRoutes } from './agents.js';
import { ruleRoutes } from './rules.js';
import { conversationRoutes } from './conversations.js';

let app: Hono;
let db: Db;
let wsA: string;
let wsB: string;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

const post = (path: string, cookie: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const makeUser = async (
  email: string,
  workspaceId: string | null,
  role: 'admin' | 'member' = 'member',
) => {
  const [u] = await db
    .insert(users)
    .values({ email, name: email, passwordHash: await hashPassword('password123') })
    .returning();
  if (workspaceId) {
    await db.insert(memberships).values({
      userId: u.id,
      workspaceId,
      role,
      acceptedAt: new Date(),
    });
  }
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  return { user: u, cookie: `${SESSION_COOKIE}=${token}` };
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono()
    .route('/auth', authRoutes(db))
    .route('/api/users', userRoutes(db))
    .route('/api/agents', agentRoutes(db))
    .route('/api/rules', ruleRoutes(db))
    .route('/api/conversations', conversationRoutes(db));

  const [a] = await db.insert(workspaces).values({ name: 'Alpha' }).returning();
  const [b] = await db.insert(workspaces).values({ name: 'Beta' }).returning();
  wsA = a.id;
  wsB = b.id;
  adminCookie = (await makeUser('admin@x.test', wsA, 'admin')).cookie;
  const member = await makeUser('member@x.test', wsA, 'member');
  memberCookie = member.cookie;
  memberId = member.user.id;
});

describe('role enforcement', () => {
  it('member gets 403 on admin-only routes', async () => {
    for (const [path, method, body] of [
      ['/api/users', 'POST', { email: 'x@y.z', name: 'X', password: 'password123' }],
      ['/api/agents', 'POST', { name: 'Bot' }],
      ['/api/rules', 'POST', { kind: 'keyword' }],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', cookie: memberCookie },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('member can still use the inbox endpoints', async () => {
    const res = await app.request('/api/conversations', { headers: { cookie: memberCookie } });
    expect(res.status).toBe(200);
    const usersRes = await app.request('/api/users', { headers: { cookie: memberCookie } });
    expect(usersRes.status).toBe(200);
  });

  it('admin can list the team', async () => {
    const res = await app.request('/api/users', { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.map((u: { email: string }) => u.email)).toContain('member@x.test');
  });
});

describe('invites', () => {
  it('inviting an existing Janis account creates a pending membership', async () => {
    const outsider = await makeUser('other@x.test', wsB, 'admin');
    const res = await post('/api/users', adminCookie, { email: 'other@x.test' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.status).toBe('invited');

    const [mem] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, outsider.user.id), eq(memberships.workspaceId, wsA)));
    expect(mem.acceptedAt).toBeNull();
  });

  it('matches existing accounts case-insensitively', async () => {
    // 'other@x.test' already has a pending invite on wsA from the test above —
    // a differently-cased, whitespace-padded invite must hit the same account
    const res = await post('/api/users', adminCookie, { email: '  Other@X.Test  ' });
    expect(res.status).toBe(409); // invite already pending — not a new account
  });

  it('rejects a duplicate invite and an existing member', async () => {
    const res = await post('/api/users', adminCookie, { email: 'other@x.test' });
    expect(res.status).toBe(409);
    const res2 = await post('/api/users', adminCookie, { email: 'member@x.test' });
    expect(res2.status).toBe(409);
  });

  it('new emails get a passwordless account with a pending invite', async () => {
    const ok = await post('/api/users', adminCookie, {
      email: 'newbie@x.test',
      name: 'Newbie',
    });
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.user.status).toBe('invited');
    // the account exists but has no password and no accepted membership — it
    // activates when they sign in via OAuth and accept the invite
    const [u] = await db.select().from(users).where(eq(users.email, 'newbie@x.test'));
    expect(u.passwordHash).toBeNull();
    const [mem] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, u.id), eq(memberships.workspaceId, wsA)));
    expect(mem.acceptedAt).toBeNull();
  });
});

describe('invite acceptance and switching', () => {
  it('/auth/me exposes workspaces and pending invites', async () => {
    const res = await app.request('/auth/me', { headers: { cookie: adminCookie } });
    const body = await res.json();
    expect(body.workspace.name).toBe('Alpha');
    expect(body.workspaces.map((w: { name: string }) => w.name)).toEqual(['Alpha']);
  });

  it('accepting an invite grants access to the new workspace', async () => {
    // fresh user whose only membership is pending on wsA — sessionAuth would
    // 401, so the accept endpoint must work off the bare session
    const invited = await makeUser('invited@x.test', null);
    await db.insert(memberships).values({
      userId: invited.user.id,
      workspaceId: wsA,
      role: 'member',
    });
    const meRes = await app.request('/auth/me', { headers: { cookie: invited.cookie } });
    const me = await meRes.json();
    expect(me.workspace).toBeNull();
    expect(me.invites).toHaveLength(1);

    const res = await post(`/auth/invites/${me.invites[0].id}/accept`, invited.cookie);
    expect(res.status).toBe(200);

    const meRes2 = await app.request('/auth/me', { headers: { cookie: invited.cookie } });
    const me2 = await meRes2.json();
    expect(me2.workspace?.name).toBe('Alpha');
    // session now authorized against the workspace
    const list = await app.request('/api/conversations', {
      headers: { cookie: invited.cookie },
    });
    expect(list.status).toBe(200);
  });

  it('declining removes the pending membership', async () => {
    const invited = await makeUser('decliner@x.test', null);
    const [mem] = await db
      .insert(memberships)
      .values({ userId: invited.user.id, workspaceId: wsA })
      .returning();
    const res = await post(`/auth/invites/${mem.id}/decline`, invited.cookie);
    expect(res.status).toBe(200);
    const [gone] = await db.select().from(memberships).where(eq(memberships.id, mem.id));
    expect(gone).toBeUndefined();
  });

  it('/auth/switch repoints the session at another accepted workspace', async () => {
    // give the admin a second accepted membership on wsB
    const [admin] = await db.select().from(users).where(eq(users.email, 'admin@x.test'));
    await db.insert(memberships).values({
      userId: admin.id,
      workspaceId: wsB,
      role: 'member',
      acceptedAt: new Date(),
    });

    const res = await post('/auth/switch', adminCookie, { workspace_id: wsB });
    expect(res.status).toBe(200);
    const me = await (await app.request('/auth/me', { headers: { cookie: adminCookie } })).json();
    expect(me.workspace.name).toBe('Beta');
    expect(me.user.role).toBe('member'); // role follows the membership

    // member role on wsB → admin routes deny
    const denied = await post('/api/users', adminCookie, { email: 'z@y.z' });
    expect(denied.status).toBe(403);

    // switch back
    await post('/auth/switch', adminCookie, { workspace_id: wsA });
    const me2 = await (await app.request('/auth/me', { headers: { cookie: adminCookie } })).json();
    expect(me2.workspace.name).toBe('Alpha');
    expect(me2.user.role).toBe('admin');
  });

  it('refuses to switch to a workspace without membership', async () => {
    const res = await post('/auth/switch', memberCookie, { workspace_id: wsB });
    expect(res.status).toBe(403);
  });
});

describe('password change', () => {
  it('changes the password with the correct current one', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ password: { current: 'password123', new: 'newpassword9' } }),
    });
    expect(res.status).toBe(200);
    // new password logs in
    const login = await post('/auth/login', '', {
      email: 'member@x.test',
      password: 'newpassword9',
    });
    expect(login.status).toBe(200);
    // old password no longer does
    const stale = await post('/auth/login', '', {
      email: 'member@x.test',
      password: 'password123',
    });
    expect(stale.status).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ password: { current: 'wrong', new: 'whatever99' } }),
    });
    expect(res.status).toBe(403);
  });
});

describe('operator profile', () => {
  it('updates display name and avatar, and clears them with null', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ display_name: 'Agent M', avatar_url: '/uploads/me.png' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.display_name).toBe('Agent M');
    expect(body.user.avatar_url).toBe('/uploads/me.png');

    // empty string clears the display name back to first-name default
    const cleared = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ display_name: '  ', avatar_url: null }),
    });
    const cb = await cleared.json();
    expect(cb.user.display_name).toBeNull();
    expect(cb.user.avatar_url).toBeNull();
  });

  it('rejects avatar urls outside /uploads/', async () => {
    const res = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ avatar_url: 'https://evil.test/x.png' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('last workspace persistence', () => {
  const loginCookie = async (email: string) => {
    const res = await post('/auth/login', '', { email, password: 'password123' });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  };

  it('a new session opens in the workspace the user was last in', async () => {
    const u = await makeUser('switcher@x.test', wsA, 'member');
    await db.insert(memberships).values({
      userId: u.user.id,
      workspaceId: wsB,
      role: 'admin',
      acceptedAt: new Date(),
    });

    // first login lands on the first membership (Alpha)
    let cookie = await loginCookie('switcher@x.test');
    let me = await (await app.request('/auth/me', { headers: { cookie } })).json();
    expect(me.workspace.name).toBe('Alpha');

    // switch to Beta, log out, log back in → still Beta
    await post('/auth/switch', cookie, { workspace_id: wsB });
    await post('/auth/logout', cookie);
    cookie = await loginCookie('switcher@x.test');
    me = await (await app.request('/auth/me', { headers: { cookie } })).json();
    expect(me.workspace.name).toBe('Beta');
    expect(me.user.role).toBe('admin');
  });

  it('falls back to the first membership when the last workspace is gone', async () => {
    const u = await makeUser('orphan@x.test', wsA, 'member');
    await db
      .update(users)
      .set({ lastWorkspaceId: wsB }) // stale — no membership there
      .where(eq(users.id, u.user.id));
    const cookie = await loginCookie('orphan@x.test');
    const me = await (await app.request('/auth/me', { headers: { cookie } })).json();
    expect(me.workspace.name).toBe('Alpha');
  });
});

describe('workspace isolation', () => {
  it('a user only sees their active workspace', async () => {
    // member is only on wsA; wsB has no agents visible to them
    const res = await app.request('/api/agents', { headers: { cookie: memberCookie } });
    const body = await res.json();
    expect(body.agents).toHaveLength(0);
  });
});
