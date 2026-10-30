import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, channels, conversations, messages, workspaces } from '../db/schema.js';
import { botIngestRoutes } from './botIngest.js';

let db: Db;
let app: Hono;
let wsId: string;
const KEY = 'bk_test_ingest_key';
const LEGACY_KEY = 'ck_migrated_bot';

process.env.BOT_INGEST_WAIT_MS = '400';

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  app = new Hono().route('/bot', botIngestRoutes(db));

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  wsId = ws.id;
  await db.insert(agents).values({ workspaceId: wsId, name: 'Bot', metadata: { bot_key: KEY } });
  await db.insert(agents).values({ workspaceId: wsId, name: 'Migrated', metadata: { legacy_client_key: LEGACY_KEY } });
});

const agentFor = async (key: string) =>
  (await db.select().from(agents).where(eq(agents.name, key === KEY ? 'Bot' : 'Migrated')).limit(1))[0];

describe('bot ingest', () => {
  it('404s an unknown key and unknown flavor', async () => {
    expect((await app.request('/bot/nope/chatfuel', { method: 'POST' })).status).toBe(404);
    expect((await app.request(`/bot/${KEY}/discord`, { method: 'POST' })).status).toBe(404);
  });

  it('ingests a chatfuel turn — conv + stored inbound, chatfuel-shaped reply', async () => {
    const agent = await agentFor(KEY);
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-1', 'user input': 'hello there' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('messages');

    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-1')));
    expect(conv).toBeTruthy();
    const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id));
    expect(ch.kind).toBe('chatfuel');
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(msg.direction).toBe('in');
  });

  it('returns the empty manychat shape when the agent stays silent', async () => {
    const r = await app.request(`/bot/${KEY}/manychat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sub-9', custom_fields: { 'user input': 'hi' } }),
    });
    const body = await r.json();
    expect(body.version).toBe('v2');
    expect(body.content.messages).toEqual([]);
  }, 20_000);

  it('accepts a migrated agent on its legacy client_key', async () => {
    const agent = await agentFor(LEGACY_KEY);
    const r = await app.request(`/bot/${LEGACY_KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-7', 'user input': 'migrated' }),
    });
    expect(r.status).toBe(200);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-7')));
    expect(conv).toBeTruthy();
  }, 20_000);

  it('silent when the conversation is human-owned', async () => {
    const agent = await agentFor(KEY);
    await db
      .update(conversations)
      .set({ state: 'human' })
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, 'chatfuel:psid-1')));
    const r = await app.request(`/bot/${KEY}/chatfuel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'messenger user id': 'psid-1', 'user input': 'are you there' }),
    });
    const body = await r.json();
    expect(body.messages).toEqual([]);
  });
});
