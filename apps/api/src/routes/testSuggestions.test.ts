import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agentTests,
  agents,
  conversations,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
} from '../db/schema.js';
import { generateSessionToken } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { agentRoutes } from './agents.js';

let app: Hono;
let db: Db;
let cookie: string;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/api/agents', agentRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'WS' }).returning();
  const [u] = await db.insert(users).values({ email: 'a@b.c', name: 'A' }).returning();
  await db.insert(memberships).values({
    userId: u.id,
    workspaceId: ws.id,
    role: 'admin',
    acceptedAt: new Date(),
  });
  const { token, id } = generateSessionToken();
  await db
    .insert(sessions)
    .values({ id, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
  cookie = `${SESSION_COOKIE}=${token}`;

  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot' })
    .returning();
  agentId = agent.id;
});

const get = async () =>
  app.request(`/api/agents/${agentId}/test-suggestions`, {
    headers: { cookie },
  });

const mkConv = async (externalId: string, name?: string) => {
  const [c] = await db
    .insert(conversations)
    .values({
      agentId,
      externalId,
      channel: 'webchat',
      userProfile: name ? { name } : {},
      lastMessageAt: new Date(),
    })
    .returning();
  return c.id;
};

describe('GET /:id/test-suggestions', () => {
  it('suggests a rescued conversation and hides it once tested or dismissed', async () => {
    // conv 1: a failure-flagged turn (model rescue marker)
    const convFlag = await mkConv('w1', 'Flag Cust');
    await db.insert(messages).values([
      { conversationId: convFlag, direction: 'in', text: 'help me' },
      {
        conversationId: convFlag,
        direction: 'out',
        text: 'bad reply',
        flags: { failure: true, help_requested: false, custom_alert: false, handoff_offer: false },
      },
    ]);
    // conv 2: an operator reply (non-internal human direction)
    const convHuman = await mkConv('w2', 'Human Cust');
    await db.insert(messages).values([
      { conversationId: convHuman, direction: 'in', text: 'refund?' },
      { conversationId: convHuman, direction: 'human', text: 'on it' },
    ]);
    // conv 3: internal note only — NOT a rescue
    const convNote = await mkConv('w3', 'Note Cust');
    await db.insert(messages).values([
      { conversationId: convNote, direction: 'in', text: 'hi' },
      {
        conversationId: convNote,
        direction: 'human',
        text: 'watch this one',
        payload: { internal: true },
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const { suggestions } = await res.json();
    const ids = suggestions.map((s: { conversation_id: string }) => s.conversation_id);
    expect(ids).toContain(convFlag);
    expect(ids).toContain(convHuman);
    expect(ids).not.toContain(convNote);
    const flagSug = suggestions.find(
      (s: { conversation_id: string }) => s.conversation_id === convFlag,
    );
    expect(flagSug.name).toBe('Flag Cust');
    expect(flagSug.rescues).toBe(1);

    // covered by a test → drops off the list
    await db.insert(agentTests).values({
      agentId,
      workspaceId: (await db.select({ wid: agents.workspaceId }).from(agents).where(eq(agents.id, agentId)))[0].wid,
      name: 't',
      expectation: '',
      turns: [],
      sourceConversationId: convFlag,
    });
    const res2 = await get();
    const ids2 = (await res2.json()).suggestions.map(
      (s: { conversation_id: string }) => s.conversation_id,
    );
    expect(ids2).not.toContain(convFlag);
    expect(ids2).toContain(convHuman);

    // dismissed via config → drops off
    await db
      .update(agents)
      .set({ config: { dismissed_test_suggestions: [convHuman] } as never })
      .where(eq(agents.id, agentId));
    const res3 = await get();
    const ids3 = (await res3.json()).suggestions.map(
      (s: { conversation_id: string }) => s.conversation_id,
    );
    expect(ids3).not.toContain(convHuman);
  });
});
