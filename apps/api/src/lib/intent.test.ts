import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, alertRules, alerts, conversations, messages, workspaces } from '../db/schema.js';
import { backfillSentimentAlerts, checkInboundSentiment, recheckIntent } from './intent.js';

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

  it('scores and persists sentiment even without a rule — no alert fires', async () => {
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'this is outrageous');
    expect(fetchMock).toHaveBeenCalled(); // the score feeds the Details card
    expect(await sentimentAlerts()).toHaveLength(0); // rules gate the page
    expect((await intentOf()).sentiment).toBe('negative');
  });

  const internalNotes = async () =>
    (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter(
      (m) => (m.payload as { internal?: boolean } | null)?.internal,
    );

  it('leaves a transcript note on a rule-less negative flip', async () => {
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'this is outrageous');
    const notes = await internalNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Negative sentiment');
    expect(await sentimentAlerts()).toHaveLength(0);
  });

  it('notes the transition once — a thread that stays negative does not re-note', async () => {
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'this is outrageous');
    await checkInboundSentiment(db, agent, conv, 'still furious'); // conv.sentiment mutated in-memory
    expect(await internalNotes()).toHaveLength(1);
  });

  it('re-notes when the mood recovers then turns negative again', async () => {
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'this is outrageous');
    llmAnswer('neutral');
    await checkInboundSentiment(db, agent, conv, 'ok that helps');
    llmAnswer('negative');
    await checkInboundSentiment(db, agent, conv, 'actually no, still broken');
    expect(await internalNotes()).toHaveLength(2);
  });

  it('updates the stored mood as turns change tone', async () => {
    llmAnswer('neutral');
    await checkInboundSentiment(db, agent, conv, 'quick question about billing');
    expect((await intentOf()).sentiment).toBe('neutral');
    llmAnswer('positive');
    await checkInboundSentiment(db, agent, conv, 'that fixed it, thanks!');
    expect((await intentOf()).sentiment).toBe('positive');
  });

  it('leaves the score alone when the classifier returns nothing', async () => {
    await db
      .update(conversations)
      .set({ sentiment: 'neutral' })
      .where(eq(conversations.id, conv.id));
    fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await checkInboundSentiment(db, agent, conv, 'hello?');
    expect((await intentOf()).sentiment).toBe('neutral');
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

describe('backfillSentimentAlerts — enabling a rule surfaces existing negatives', () => {
  const sentimentAlerts = () =>
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'sentiment')));

  const makeRule = () =>
    db
      .insert(alertRules)
      .values({ agentId: agent.id, kind: 'sentiment', config: { enabled: true } })
      .returning();

  it('fires the new rule on an open conversation already scored negative', async () => {
    await db
      .update(conversations)
      .set({ sentiment: 'negative' })
      .where(eq(conversations.id, conv.id));
    const [rule] = await makeRule();
    await backfillSentimentAlerts(db, agent, rule);
    expect(await sentimentAlerts()).toHaveLength(1);
    await db.delete(alertRules);
    await db.delete(alerts);
  });

  it('skips archived threads and conversations already holding an open alert', async () => {
    const [rule] = await makeRule();
    // archived — resolved anger isn't worth a page
    await db
      .update(conversations)
      .set({ sentiment: 'negative', state: 'archived' })
      .where(eq(conversations.id, conv.id));
    await backfillSentimentAlerts(db, agent, rule);
    expect(await sentimentAlerts()).toHaveLength(0);
    // open alert already exists — a second enable must not duplicate
    await db
      .update(conversations)
      .set({ state: 'active' })
      .where(eq(conversations.id, conv.id));
    await backfillSentimentAlerts(db, agent, rule);
    expect(await sentimentAlerts()).toHaveLength(1);
    await backfillSentimentAlerts(db, agent, rule);
    expect(await sentimentAlerts()).toHaveLength(1);
    await db.delete(alertRules);
    await db.delete(alerts);
  });
});
