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
  alertRules,
  conversations,
  memberGroups,
  memberships,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken, hashPassword } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { groupRoutes } from './groups.js';
import { ruleRoutes } from './rules.js';
import { fireRuleAlert, resolveRuleRouting } from '../lib/ruleAlerts.js';
import { alerts } from '../db/schema.js';

let app: Hono;
let db: Db;
let wsId: string;
let otherWsId: string;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let agentId: string;

const req = (path: string, method: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const makeUser = async (email: string, workspaceId: string, role: 'admin' | 'member') => {
  const [u] = await db
    .insert(users)
    .values({ email, name: email, passwordHash: await hashPassword('password123') })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: u.id, workspaceId, role, acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, workspaceId, expiresAt: new Date(Date.now() + 86400_000) });
  return { user: u, cookie: `${SESSION_COOKIE}=${token}` };
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'WS' }).returning();
  wsId = ws.id;
  const [ws2] = await db.insert(workspaces).values({ name: 'Other' }).returning();
  otherWsId = ws2.id;
  const admin = await makeUser('admin@x.test', wsId, 'admin');
  adminCookie = admin.cookie;
  const member = await makeUser('member@x.test', wsId, 'member');
  memberCookie = member.cookie;
  memberId = member.user.id;
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: wsId, name: 'A', hosted: true })
    .returning();
  agentId = agent.id;

  app = new Hono();
  app.route('/api/groups', groupRoutes(db));
  app.route('/api/rules', ruleRoutes(db));
});

describe('group routes', () => {
  it('creates, lists, patches, and deletes groups', async () => {
    const created = await (
      await req('/api/groups', 'POST', adminCookie, {
        name: 'Tier 1',
        member_ids: [memberId, crypto.randomUUID()], // non-member id dropped
      })
    ).json();
    expect(created.group.name).toBe('Tier 1');
    expect(created.group.member_ids).toEqual([memberId]);

    const list = await (await req('/api/groups', 'GET', adminCookie)).json();
    expect(list.groups).toHaveLength(1);

    const patched = await (
      await req(`/api/groups/${created.group.id}`, 'PATCH', adminCookie, {
        member_ids: [],
      })
    ).json();
    expect(patched.group.member_ids).toEqual([]);

    const del = await req(`/api/groups/${created.group.id}`, 'DELETE', adminCookie);
    expect(del.status).toBe(200);
    expect((await (await req('/api/groups', 'GET', adminCookie)).json()).groups).toHaveLength(0);
  });

  it('403s non-admin writes and 404s foreign groups', async () => {
    expect(
      (await req('/api/groups', 'POST', memberCookie, { name: 'x', member_ids: [] })).status,
    ).toBe(403);
    // a group in another workspace is invisible — read by members is fine, writes aren't
    const [foreign] = await db
      .insert(memberGroups)
      .values({ workspaceId: otherWsId, name: 'F', memberIds: [] })
      .returning();
    expect(
      (await req(`/api/groups/${foreign.id}`, 'PATCH', adminCookie, { name: 'y' })).status,
    ).toBe(404);
    expect((await req(`/api/groups/${foreign.id}`, 'DELETE', adminCookie)).status).toBe(404);
  });
});

describe('agent-scoped groups', () => {
  it('creates an agent group; rosters can carry agent-only members', async () => {
    // An agent-scoped member — user with NO workspace membership but an
    // accepted agent_members row (the client-VA case).
    const [va] = await db
      .insert(users)
      .values({ email: 'va@x.test', name: 'VA', passwordHash: await hashPassword('password123') })
      .returning();
    await db
      .insert(agentMembers)
      .values({ agentId, userId: va.id, acceptedAt: new Date() });
    const outsider = await makeUser('out@y.test', otherWsId, 'member');

    const created = await (
      await req('/api/groups', 'POST', adminCookie, {
        name: 'Client on-call',
        member_ids: [memberId, va.id, outsider.user.id], // outsider dropped
        agent_id: agentId,
      })
    ).json();
    expect(created.group.agent_id).toBe(agentId);
    expect(created.group.member_ids).toEqual([memberId, va.id]);

    // Workspace groups stay workspace-only — the agent-only id drops.
    const ws = await (
      await req('/api/groups', 'POST', adminCookie, {
        name: 'WS crew',
        member_ids: [va.id],
      })
    ).json();
    expect(ws.group.agent_id).toBeNull();
    expect(ws.group.member_ids).toEqual([]);

    // agent_id pointing at another workspace's agent 404s.
    const [foreignAgent] = await db
      .insert(agents)
      .values({ workspaceId: otherWsId, name: 'FA', hosted: true })
      .returning();
    expect(
      (
        await req('/api/groups', 'POST', adminCookie, {
          name: 'x',
          member_ids: [],
          agent_id: foreignAgent.id,
        })
      ).status,
    ).toBe(404);
  });

  it('an agent-scoped admin manages their agent\u2019s groups; a member cannot', async () => {
    // Agent admin: no workspace membership, accepted agent_members admin row.
    const [admin] = await db
      .insert(users)
      .values({
        email: 'agentadmin@x.test',
        name: 'AA',
        passwordHash: await hashPassword('password123'),
      })
      .returning();
    await db
      .insert(agentMembers)
      .values({ agentId, userId: admin.id, role: 'admin', acceptedAt: new Date() });
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: admin.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 86400_000) });
    const aaCookie = `${SESSION_COOKIE}=${token}`;

    const created = await (
      await req('/api/groups', 'POST', aaCookie, {
        name: 'On-call',
        member_ids: [admin.id],
        agent_id: agentId,
      })
    ).json();
    expect(created.group.agent_id).toBe(agentId);

    const patched = await req(`/api/groups/${created.group.id}`, 'PATCH', aaCookie, { name: 'Rota' });
    expect(patched.status).toBe(200);

    // Workspace-wide groups remain workspace-admin territory.
    expect(
      (
        await req('/api/groups', 'POST', aaCookie, { name: 'x', member_ids: [] })
      ).status,
    ).toBe(403);
    // A plain workspace member can't touch the agent group either.
    expect(
      (await req(`/api/groups/${created.group.id}`, 'PATCH', memberCookie, { name: 'y' })).status,
    ).toBe(403);
    expect((await req(`/api/groups/${created.group.id}`, 'DELETE', aaCookie)).status).toBe(200);
  });

  it('rules accept their own agent\u2019s groups but reject another agent\u2019s', async () => {
    const [agent2] = await db
      .insert(agents)
      .values({ workspaceId: wsId, name: 'B', hosted: true })
      .returning();
    const [otherGroup] = await db
      .insert(memberGroups)
      .values({ workspaceId: wsId, agentId: agent2.id, name: 'B crew', memberIds: [] })
      .returning();
    const [ownGroup] = await db
      .insert(memberGroups)
      .values({ workspaceId: wsId, agentId, name: 'A crew', memberIds: [memberId] })
      .returning();

    expect(
      (
        await req('/api/rules', 'POST', adminCookie, {
          agent_id: agentId,
          kind: 'keyword',
          config: { keywords: ['x'], group_ids: [otherGroup.id] },
        })
      ).status,
    ).toBe(400);
    // Workspace groups stay usable on any agent.
    const [wsGroup] = await db
      .insert(memberGroups)
      .values({ workspaceId: wsId, name: 'All hands', memberIds: [] })
      .returning();
    expect(
      (
        await req('/api/rules', 'POST', adminCookie, {
          agent_id: agentId,
          kind: 'keyword',
          config: { keywords: ['x'], group_ids: [ownGroup.id, wsGroup.id] },
        })
      ).status,
    ).toBe(201);

    // PATCH path — swapping in a foreign agent's roster 400s too.
    const [rule] = await db
      .insert(alertRules)
      .values({ agentId, kind: 'keyword', config: { enabled: true, keywords: ['x'] } })
      .returning();
    expect(
      (
        await req(`/api/rules/${rule.id}`, 'PATCH', adminCookie, {
          config: { enabled: true, keywords: ['x'], group_ids: [otherGroup.id] },
        })
      ).status,
    ).toBe(400);
  });

  it('an agent group\u2019s agent-only member joins the rule rotation', async () => {
    const [va] = await db
      .select()
      .from(users)
      .where(eq(users.email, 'va@x.test'));
    const [group] = await db
      .insert(memberGroups)
      .values({ workspaceId: wsId, agentId, name: 'VA rota', memberIds: [va.id] })
      .returning();
    const [rule] = await db
      .insert(alertRules)
      .values({
        agentId,
        kind: 'keyword',
        config: { enabled: true, keywords: ['x'], group_ids: [group.id], next: 0 },
      })
      .returning();
    const routed = await resolveRuleRouting(db, wsId, [rule]);
    expect(routed.assigneeId).toBe(va.id);
  });
});

describe('rule routing through groups', () => {
  it('rotates pool members incl. groups and persists the cursor', async () => {
    const u2 = await makeUser('u2@x.test', wsId, 'member');
    const [group] = await db
      .insert(memberGroups)
      .values({ workspaceId: wsId, name: 'Tier 1', memberIds: [u2.user.id] })
      .returning();
    const [rule] = await db
      .insert(alertRules)
      .values({
        agentId,
        kind: 'keyword',
        config: { enabled: true, keywords: ['x'], assignees: [memberId], group_ids: [group.id], next: 0, tag: 'esc' },
      })
      .returning();

    const first = await resolveRuleRouting(db, wsId, [rule]);
    expect(first.assigneeId).toBe(memberId);
    expect(first.tags).toEqual(['esc']);
    // cursor persisted — the next fire picks the group's member
    const second = await resolveRuleRouting(db, wsId, [rule]);
    expect(second.assigneeId).toBe(u2.user.id);
    const [stored] = await db.select().from(alertRules).where(eq(alertRules.id, rule.id));
    expect((stored.config as { next?: number }).next).toBe(2);
  });

  it('fireRuleAlert opens one alert, assigns, and dedupes repeats', async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, externalId: 'conv-1' })
      .returning();
    const [rule] = await db
      .insert(alertRules)
      .values({
        agentId,
        kind: 'sentiment',
        config: { enabled: true, assign_to: memberId, tag: 'upset' },
      })
      .returning();

    await fireRuleAlert(db, agent, conv, {
      type: 'sentiment',
      detail: 'customer sentiment classified negative',
      rules: [rule],
    });
    const rows = await db.select().from(alerts).where(eq(alerts.conversationId, conv.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('sentiment');
    const [updated] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(updated.assigneeId).toBe(memberId);
    expect(updated.tags).toContain('upset');

    // repeat fire — no second alert
    await fireRuleAlert(db, agent, updated, {
      type: 'sentiment',
      detail: 'again',
      rules: [rule],
    });
    expect(
      (await db.select().from(alerts).where(eq(alerts.conversationId, conv.id))).length,
    ).toBe(1);
  });
});
