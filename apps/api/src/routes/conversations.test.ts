import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, sessions, users, workspaces } from '../db/schema.js';
import { generateApiKey, generateSessionToken, hashPassword } from '../lib/crypto.js';
import { conversationRoutes } from './conversations.js';
import { takeover } from '../services/takeover.js';

let app: Hono;
let db: Db;
let adminCookie: string;
let memberCookie: string;
let agent: typeof agents.$inferSelect;
let wsId: string;

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
  app = new Hono().route('/api/conversations', conversationRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  const [admin] = await db
    .insert(users)
    .values({
      workspaceId: ws.id,
      email: 'admin@x.c',
      name: 'Admin',
      role: 'admin',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  const [member] = await db
    .insert(users)
    .values({
      workspaceId: ws.id,
      email: 'member@x.c',
      name: 'Member',
      role: 'member',
      passwordHash: await hashPassword('password123'),
    })
    .returning();
  adminCookie = await seedSession(admin.id);
  memberCookie = await seedSession(member.id);

  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
      .returning()
  )[0];
});

async function makeConversation(externalId: string) {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agent.id, externalId })
    .returning();
  return conv;
}

const post = (path: string, cookie: string, body: unknown) =>
  app.request(`/api/conversations${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('internal notes', () => {
  it('stores an internal note without changing state or reaching the customer', async () => {
    const conv = await makeConversation('note-conv');
    const res = await post(`/${conv.id}/note`, adminCookie, { text: 'checking with billing' });
    expect(res.status).toBe(201);
    const { message } = await res.json();
    expect(message.direction).toBe('human');
    expect(message.payload.internal).toBe(true);

    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.state).toBe('active'); // note did not take over
    expect(after.lastMessagePreview).toContain('🔒');
  });

  it('does not reset the auto-resume clock during a takeover', async () => {
    const conv = await makeConversation('note-takeover');
    const [admin] = await db.select().from(users).where(eq(users.email, 'admin@x.c'));
    await takeover(db, wsId, conv.id, admin);
    const staleSince = new Date(Date.now() - 20 * 60_000);
    await db
      .update(conversations)
      .set({ humanSince: staleSince })
      .where(eq(conversations.id, conv.id));

    const res = await post(`/${conv.id}/note`, adminCookie, { text: 'still investigating' });
    expect(res.status).toBe(201);
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.humanSince!.getTime()).toBe(staleSince.getTime());
  });

  it('is open to members too', async () => {
    const conv = await makeConversation('note-member');
    const res = await post(`/${conv.id}/note`, memberCookie, { text: 'anyone home?' });
    expect(res.status).toBe(201);
  });
});

describe('teach', () => {
  it('admin teach appends to agent knowledge and records a note', async () => {
    const conv = await makeConversation('teach-conv');
    const res = await post(`/${conv.id}/teach`, adminCookie, {
      text: 'Refunds over $50 need manager approval',
    });
    expect(res.status).toBe(201);
    const { knowledge_count } = await res.json();
    expect(knowledge_count).toBe(1);

    const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((after.config as { knowledge: string[] }).knowledge).toContain(
      'Refunds over $50 need manager approval',
    );

    const [note] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(note.payload.internal).toBe(true);
    expect(note.payload.teach).toBe(true);
  });

  it('members cannot teach', async () => {
    const conv = await makeConversation('teach-denied');
    const res = await post(`/${conv.id}/teach`, memberCookie, { text: 'should not learn this' });
    expect(res.status).toBe(403);
    const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((after.config as { knowledge: string[] }).knowledge).not.toContain(
      'should not learn this',
    );
  });
});
