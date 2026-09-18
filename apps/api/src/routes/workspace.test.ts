import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  alertRules,
  alerts,
  channelBindings,
  channels,
  conversations,
  digests,
  knowledgeFiles,
  agentSecrets,
  messages,
  metaConnections,
  pushSubscriptions,
  savedReplies,
  sessions,
  slackInstallations,
  slackThreads,
  suggestions,
  usageEvents,
  users,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { generateApiKey, generateSessionToken, hashPassword } from '../lib/crypto.js';
import { workspaceRoutes } from './workspace.js';

let app: Hono;
let db: Db;
let cookie: string;
let wsId: string;

const counts = async () =>
  Promise.all(
    [
      workspaces,
      users,
      sessions,
      agents,
      conversations,
      messages,
      alerts,
      alertRules,
      pushSubscriptions,
      metaConnections,
      slackInstallations,
      suggestions,
      savedReplies,
      digests,
      slackThreads,
      channels,
      channelBindings,
      usageEvents,
      knowledgeFiles,
      agentSecrets,
      webhookDeliveries,
    ].map(async (t) => (await db.select().from(t)).length),
  );

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/workspace', workspaceRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Doomed' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({
      workspaceId: ws.id,
      email: 'a@b.c',
      name: 'Admin',
      role: 'admin',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;

  // seed one of everything so the delete has to clear every FK level
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId: 'c1', assigneeId: admin.id })
    .returning();
  await db.insert(messages).values({ conversationId: conv.id, direction: 'in', authorId: admin.id });
  await db.insert(alerts).values({ conversationId: conv.id, type: 'failure' });
  await db.insert(suggestions).values({ conversationId: conv.id, text: 'hi', source: 'agent' });
  const [install] = await db
    .insert(slackInstallations)
    .values({ workspaceId: ws.id, teamId: 'T1', botToken: 'xoxb', installerUserId: admin.id })
    .returning();
  await db
    .insert(slackThreads)
    .values({ conversationId: conv.id, installationId: install.id, channelId: 'C1', ts: '1.0' });
  const [chan] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: agent.id, kind: 'messenger', name: 'Page' })
    .returning();
  await db
    .insert(channelBindings)
    .values({ channelId: chan.id, conversationId: conv.id, platformUserId: 'psid1' });
  await db.insert(alertRules).values({ agentId: agent.id, kind: 'failure' });
  await db.insert(knowledgeFiles).values({
    workspaceId: ws.id,
    agentId: agent.id,
    name: 'k.txt',
    mimeType: 'text/plain',
    sizeBytes: 3,
    text: 'abc',
  });
  await db.insert(agentSecrets).values({ workspaceId: ws.id, agentId: agent.id, name: 'k', valueEnc: 'x' });
  await db.insert(webhookDeliveries).values({ agentId: agent.id, type: 'handoff', payload: {} });
  await db.insert(usageEvents).values({ workspaceId: ws.id, agentId: agent.id, conversationId: conv.id, kind: 'llm_tokens', period: '2026-09' });
  await db.insert(pushSubscriptions).values({ userId: admin.id, endpoint: 'https://push/x', keys: {} });
  await db.insert(metaConnections).values({ workspaceId: ws.id, userToken: 'tok' });
  await db.insert(savedReplies).values({ workspaceId: ws.id, title: 'r', body: 'b' });
  await db.insert(digests).values({
    workspaceId: ws.id,
    periodStart: new Date(),
    periodEnd: new Date(),
    stats: {},
  });
});

describe('DELETE /api/workspace', () => {
  it('rejects non-admins', async () => {
    const [ws2] = await db.insert(workspaces).values({ name: 'Other' }).returning();
    const [member] = await db
      .insert(users)
      .values({ workspaceId: ws2.id, email: 'm@b.c', name: 'M', role: 'member', passwordHash: 'x' })
      .returning();
    const { token, id } = generateSessionToken();
    await db
      .insert(sessions)
      .values({ id, userId: member.id, expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await app.request('/api/workspace', {
      method: 'DELETE',
      headers: { Cookie: `janis_session=${token}` },
    });
    expect(res.status).toBe(403);
    // the other workspace is untouched
    expect((await db.select().from(workspaces).where(eq(workspaces.id, ws2.id))).length).toBe(1);
  });

  it('deletes the workspace and all attached rows', async () => {
    const res = await app.request('/api/workspace', { method: 'DELETE', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    // every table except the untouched second workspace's users/sessions
    const remaining = await counts();
    expect(remaining[0]).toBe(1); // workspaces: only ws2
    expect(remaining[1]).toBe(1); // users: only member
    expect(remaining[2]).toBe(1); // sessions: only member's
    expect(remaining.slice(3)).toEqual(Array(18).fill(0));
    expect((await db.select().from(workspaces).where(eq(workspaces.id, wsId))).length).toBe(0);
  });
});
