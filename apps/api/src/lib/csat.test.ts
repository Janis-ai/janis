import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
import { generateApiKey } from './crypto.js';
import { captureCsat, parseCsatRating, sendCsatPrompt } from './csat.js';

let db: Db;
let agentId: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const { hash, preview } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: ws.id, name: 'Bot', apiKeyHash: hash, apiKeyPreview: preview })
    .returning();
  agentId = agent.id;
});

async function makeConv(msgCount = 0) {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, externalId: `t:${crypto.randomUUID()}` })
    .returning();
  for (let i = 0; i < msgCount; i++) {
    await db
      .insert(messages)
      .values({ conversationId: conv.id, direction: i % 2 ? 'out' : 'in', text: `m${i}` });
  }
  return conv;
}

describe('parseCsatRating', () => {
  it('accepts bare and decorated 1–5 replies', () => {
    expect(parseCsatRating('5')).toBe(5);
    expect(parseCsatRating('  4!')).toBe(4);
    expect(parseCsatRating('3 - it was ok')).toBe(3);
    expect(parseCsatRating('2/5')).toBe(2);
    expect(parseCsatRating('1')).toBe(1);
  });
  it('rejects non-ratings and out-of-range numbers', () => {
    expect(parseCsatRating('10')).toBeNull();
    expect(parseCsatRating('0')).toBeNull();
    expect(parseCsatRating('thanks!')).toBeNull();
    expect(parseCsatRating('')).toBeNull();
    expect(parseCsatRating('order 12345')).toBeNull();
  });
});

describe('sendCsatPrompt', () => {
  it('skips conversations with no exchange', async () => {
    const conv = await makeConv(0);
    await sendCsatPrompt(db, conv);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(row.csatPending).toBe(false);
    expect(row.csatAskedAt).toBeNull();
  });

  it('sends the rating prompt once and flags the conversation pending', async () => {
    const conv = await makeConv(3);
    await sendCsatPrompt(db, conv);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(row.csatPending).toBe(true);
    expect(row.csatAskedAt).not.toBeNull();
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgs.filter((m) => (m.payload as { via?: string }).via === 'csat')).toHaveLength(1);

    // second archive — already asked, no double prompt
    await sendCsatPrompt(db, row);
    const again = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(again.filter((m) => (m.payload as { via?: string }).via === 'csat')).toHaveLength(1);
  });
});

describe('captureCsat', () => {
  it('records a rating and replies thanks', async () => {
    const conv = await makeConv(2);
    await sendCsatPrompt(db, conv);
    const [pending] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(await captureCsat(db, pending, '5')).toBe(true);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(row.csatScore).toBe(5);
    expect(row.csatPending).toBe(false);
  });

  it('clears the prompt but passes a non-rating reply through', async () => {
    const conv = await makeConv(2);
    await sendCsatPrompt(db, conv);
    const [pending] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(await captureCsat(db, pending, 'actually I have another question')).toBe(false);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(row.csatPending).toBe(false);
    expect(row.csatScore).toBeNull();
  });

  it('ignores conversations with no pending prompt', async () => {
    const conv = await makeConv(2);
    expect(await captureCsat(db, conv, '5')).toBe(false);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(row.csatScore).toBeNull();
  });
});
