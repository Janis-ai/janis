import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alertRules, alerts, conversations, messages, workspaces } from '../db/schema.js';
import { checkInboundSentiment, recheckIntent } from './intent.js';

let db: Db;
let agent: typeof schema.agents.$inferSelect;
let conv: typeof schema.conversations.$inferSelect;

let fetchMock: ReturnType<typeof vi.fn>;
const llmAnswer = (label: string) => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: label } }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws.id,
      name: 'Bot',
      // BYOK — skips the metered-rate check in llmFor; fetch is stubbed.
      config: { llm: { api_key: 'k', base_url: 'https://llm.test', model: 'm' } },
    })
    .returning();
});

beforeEach(async () => {
  await db.delete(messages);
  await db.delete(conversations);
  [conv] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      externalId: 'drift-1',
      channel: 'webchat',
      intent: 'billing',
      intentSource: 'ai',
      intentCheckedAt: new Date(Date.now() - 20 * 60_000), // past the throttle
    })
    .returning();
  for (const t of ['actually cancel my account', 'I want to cancel', 'close this account']) {
    await db.insert(messages).values({ conversationId: conv.id, direction: 'in', text: t });
  }
});

const intentOf = async () =>
  (await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0];

describe('recheckIntent — drift detection', () => {
  it('updates the intent when the conversation drifts to another label', async () => {
    llmAnswer('cancellation');
    await recheckIntent(db, agent, conv);
    const after = intentOf();
    expect((await after).intent).toBe('cancellation');
  });

  it('re-fires the new intent\'s rule tags on drift', async () => {
    await db.insert(alertRules).values({
      agentId: agent.id,
      kind: 'custom_alert',
      config: { intents: ['cancellation'], tag: 'churn-risk', enabled: true },
    });
    llmAnswer('cancellation');
    await recheckIntent(db, agent, conv);
    expect((await intentOf()).tags).toContain('churn-risk');
    await db.delete(alertRules);
  });

  it('never overwrites a manual or byo label', async () => {
    for (const source of ['manual', 'byo'] as const) {
      await db
        .update(conversations)
        .set({ intentSource: source, intentCheckedAt: new Date(0) })
        .where(eq(conversations.id, conv.id));
      llmAnswer('cancellation');
      await recheckIntent(db, agent, { ...conv, intentSource: source, intentCheckedAt: new Date(0) });
      expect((await intentOf()).intent).toBe('billing');
      await db
        .update(conversations)
        .set({ intentSource: 'ai', intentCheckedAt: new Date(0) })
        .where(eq(conversations.id, conv.id));
    }
  });

  it("keeps the old label when the window classifies 'other'", async () => {
    llmAnswer('other');
    await recheckIntent(db, agent, conv);
    expect((await intentOf()).intent).toBe('billing');
  });

  it('throttles to one check per 15 minutes', async () => {
    await db
      .update(conversations)
      .set({ intentCheckedAt: new Date() })
      .where(eq(conversations.id, conv.id));
    llmAnswer('cancellation');
    await recheckIntent(db, agent, { ...conv, intentCheckedAt: new Date() });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await intentOf()).intent).toBe('billing');
  });
});

describe('checkInboundSentiment — per-message tone check', () => {
  const sentimentAlerts = () =>
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'sentiment')));

  it('fires a sentiment rule on a hostile mid-thread message', async () => {
    await db.insert(alertRules).values({
      agentId: agent.id,
      kind: 'sentiment',
      config: { enabled: true },
    });
    llmAnswer('negative');
    // mid-thread: the conv is already classified AND the drift throttle is
    // fresh — this must still fire (the 15-min recheck window can't gate it)
    await checkInboundSentiment(db, agent, { ...conv, intentCheckedAt: new Date() }, 'this is outrageous');
    const rows = await sentimentAlerts();
    expect(rows).toHaveLength(1);
    await db.delete(alertRules);
    await db.delete(alerts);
  });

  it('does nothing without a sentiment rule — no LLM call', async () => {
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'this is outrageous');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sentimentAlerts()).toHaveLength(0);
  });

  it('ignores a non-negative read', async () => {
    await db.insert(alertRules).values({
      agentId: agent.id,
      kind: 'sentiment',
      config: { enabled: true },
    });
    llmAnswer('neutral');
    await checkInboundSentiment(db, agent, conv, 'quick question about billing');
    expect(await sentimentAlerts()).toHaveLength(0);
    await db.delete(alertRules);
    await db.delete(alerts);
  });
});
