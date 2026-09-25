import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, memberships, messages, sessions, users, workspaces } from '../db/schema.js';
import { generateApiKey, generateSessionToken, hashPassword } from '../lib/crypto.js';
import { searchRoutes } from './search.js';

let app: Hono;
let db: Db;
let cookie: string;
let adminId: string;
let agentA: typeof agents.$inferSelect;
let agentB: typeof agents.$inferSelect;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/search', searchRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const [admin] = await db
    .insert(users)
    .values({ email: 'admin@x.c', name: 'Admin', passwordHash: await hashPassword('password123') })
    .returning();
  adminId = admin.id;
  await db
    .insert(memberships)
    .values({ userId: admin.id, workspaceId: ws.id, role: 'admin', acceptedAt: new Date() });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) });
  cookie = `janis_session=${token}`;

  const { hash, preview } = generateApiKey();
  agentA = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot A', apiKeyHash: hash, apiKeyPreview: preview })
      .returning()
  )[0];
  const k2 = generateApiKey();
  agentB = (
    await db
      .insert(agents)
      .values({ workspaceId: ws.id, name: 'Bot B', apiKeyHash: k2.hash, apiKeyPreview: k2.preview })
      .returning()
  )[0];
});

async function makeConv(
  externalId: string,
  opts: Partial<typeof conversations.$inferInsert> = {},
) {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId: agentA.id, externalId, ...opts })
    .returning();
  await db
    .insert(messages)
    .values({ conversationId: conv.id, direction: 'in', text: `needle in ${externalId}` });
  return conv;
}

const search = (qs: string) =>
  app.request(`/api/search?${qs}`, { headers: { cookie } });

describe('search filters', () => {
  it('matches all text hits with no filters', async () => {
    const conv = await makeConv('plain-hit');
    const res = await search('q=needle');
    const ids = (await res.json()).conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(conv.id);
  });

  it('respects state filter', async () => {
    const active = await makeConv('state-active');
    const needy = await makeConv('state-needy', { state: 'needs_human' });
    const res = await search('q=needle&state=needs_human');
    const ids = (await res.json()).conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(needy.id);
    expect(ids).not.toContain(active.id);
  });

  it('hides archived by default, includes them when filtered', async () => {
    const archived = await makeConv('archived-hit', { state: 'archived' });
    const def = await search('q=archived-hit');
    expect((await def.json()).conversations.map((c: { id: string }) => c.id)).not.toContain(
      archived.id,
    );
    const filtered = await search('q=archived-hit&state=archived');
    expect(
      (await filtered.json()).conversations.map((c: { id: string }) => c.id),
    ).toContain(archived.id);
  });

  it('respects agent_id filter', async () => {
    const a = await makeConv('agent-a');
    const [b] = await db
      .insert(conversations)
      .values({ agentId: agentB.id, externalId: 'agent-b' })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: b.id, direction: 'in', text: 'needle in agent-b' });
    const res = await search(`q=needle&agent_id=${agentB.id}`);
    const ids = (await res.json()).conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it('respects assignee=me', async () => {
    const mine = await makeConv('mine-conv', { assigneeId: adminId });
    const other = await makeConv('other-conv');
    const res = await search('q=needle&assignee=me');
    const ids = (await res.json()).conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });

  it('respects attention filter', async () => {
    const needy = await makeConv('attn-needy', { state: 'needs_human' });
    const plain = await makeConv('attn-plain');
    const res = await search('q=needle&attention=1');
    const ids = (await res.json()).conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(needy.id);
    expect(ids).not.toContain(plain.id);
  });
});
