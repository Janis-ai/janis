import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  agents,
  channels,
  conversations,
  messages,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { handleChannelMessage } from './channelIngress.js';

let db: Db;
let agent: typeof agents.$inferSelect;
let channel: typeof channels.$inferSelect;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });

  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  agent = (
    await db
      .insert(agents)
      .values({
        workspaceId: ws.id,
        name: 'Bot',
        apiKeyHash: hash,
        apiKeyPreview: preview,
        webhookUrl: 'https://agent.test/hook',
      })
      .returning()
  )[0];
  channel = (
    await db
      .insert(channels)
      .values({
        workspaceId: ws.id,
        agentId: agent.id,
        kind: 'messenger',
        name: 'Page',
        credentials: { page_id: 'PG1', access_token: 'tok' },
      })
      .returning()
  )[0];
});

afterEach(() => vi.unstubAllGlobals());

describe('handleChannelMessage dedup', () => {
  it('ignores the same platform message delivered via a second path', async () => {
    // profile fetch + webhook attempt both go through fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const msg = { objectId: 'PG1', senderId: 'PSID1', text: 'hi', messageId: 'mid.dup' };
    await handleChannelMessage(db, channel, msg);
    await handleChannelMessage(db, channel, msg); // legacy relay copy

    const [conv] = await db.select().from(conversations);
    const inbound = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(inbound).toHaveLength(1);
    expect((inbound[0].payload as { mid?: string }).mid).toBe('mid.dup');

    // the agent was invoked exactly once
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(1);
  });

  it('processes a different mid as a new message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await handleChannelMessage(db, channel, {
      objectId: 'PG1',
      senderId: 'PSID1',
      text: 'again',
      messageId: 'mid.other',
    });
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(2);
  });
});
