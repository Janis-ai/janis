import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { detectKnowledgeGaps, draftKnowledgeEntry } from './knowledgeGaps.js';

let db: Db;
let agent: typeof agents.$inferSelect;
let otherAgent: typeof agents.$inferSelect;

/** Seed a conversation with a question, a handoff flag, and a human resolution. */
async function seedHandoff(
  agentId: string,
  ext: string,
  question: string,
  resolution: string | null,
  at = new Date(),
) {
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, externalId: ext })
    .returning();
  await db.insert(messages).values({
    conversationId: conv.id,
    direction: 'in',
    text: question,
    createdAt: new Date(at.getTime() - 60_000),
  });
  await db.insert(messages).values({
    conversationId: conv.id,
    direction: 'out',
    text: 'Handoff requested',
    flags: { failure: false, help_requested: true, custom_alert: false },
    createdAt: at,
  });
  if (resolution) {
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'human',
      text: resolution,
      createdAt: new Date(at.getTime() + 60_000),
    });
  }
  return conv;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'Test' }).returning();
  const k1 = generateApiKey();
  const k2 = generateApiKey();
  const [a, b] = await db
    .insert(agents)
    .values([
      { workspaceId: ws.id, name: 'Bot', apiKeyHash: k1.hash, apiKeyPreview: k1.preview },
      { workspaceId: ws.id, name: 'Other', apiKeyHash: k2.hash, apiKeyPreview: k2.preview },
    ])
    .returning();
  agent = a;
  otherAgent = b;

  // Two similar "refund" handoffs + one unrelated question on `agent`.
  await seedHandoff(agent.id, 'c1', 'how do i get a refund for my order?', 'You get a refund within 30 days.');
  await seedHandoff(agent.id, 'c2', 'can i get a refund on my order please', 'Refunds are allowed within 30 days of purchase.');
  await seedHandoff(agent.id, 'c3', 'what are your support hours?', 'We are online 9-5 ET.');
});

afterEach(() => vi.unstubAllGlobals());

describe('detectKnowledgeGaps', () => {
  it('clusters repeated questions from flagged handoffs', async () => {
    const gaps = await detectKnowledgeGaps(db, agent.id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].count).toBe(2);
    expect(gaps[0].questions.length).toBe(2);
    expect(gaps[0].resolutions.length).toBeGreaterThan(0);
    expect(gaps[0].conversation_ids).toHaveLength(2);
    expect(gaps[0].added).toBe(false);
  });

  it('does not leak gaps across agents', async () => {
    expect(await detectKnowledgeGaps(db, otherAgent.id)).toEqual([]);
  });

  it('marks clusters added when a similar knowledge entry exists', async () => {
    // entries approved through the draft flow embed the question — deterministic match
    await db
      .update(agents)
      .set({
        config: {
          knowledge: [
            'Q: how do i get a refund for my order? A: Refunds are allowed within 30 days of purchase.',
          ],
        },
      })
      .where(eq(agents.id, agent.id));
    const gaps = await detectKnowledgeGaps(db, agent.id);
    expect(gaps[0].added).toBe(true);
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
  });
});

describe('draftKnowledgeEntry', () => {
  it('falls back to a Q/A template when the LLM is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no llm')));
    const draft = await draftKnowledgeEntry(
      db,
      agent,
      ['how do i get a refund?'],
      ['You get a refund within 30 days.'],
    );
    expect(draft).toContain('how do i get a refund?');
    expect(draft).toContain('refund within 30 days');
  });
});
