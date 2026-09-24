import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, conversations, messages, workspaces } from '../db/schema.js';
import { generateApiKey } from '../lib/crypto.js';
import { detectKnowledgeGaps, draftKnowledgeEntry, listLearnNotes, recheckGaps } from './knowledgeGaps.js';

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

/** Seed a conversation where the agent answered the question itself — 'in'
 * followed by a clean 'out' with no alert flags. */
async function seedHandled(
  agentId: string,
  ext: string,
  question: string,
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
    createdAt: at,
  });
  await db.insert(messages).values({
    conversationId: conv.id,
    direction: 'out',
    text: 'Here is your answer.',
    flags: { failure: false, help_requested: false, custom_alert: false },
    createdAt: new Date(at.getTime() + 30_000),
  });
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

describe('listLearnNotes', () => {
  it('surfaces deduped LEARN payloads, newest first, with added flag', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId: agent.id, externalId: 'learn-conv' })
      .returning();
    await db.insert(messages).values([
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'answer',
        payload: { learn: ['returns are 30 days', 'shipping is flat-rate'] },
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'answer again',
        payload: { learn: ['Returns are 30 days'] }, // dupe, different case
        createdAt: new Date(),
      },
      {
        conversationId: conv.id,
        direction: 'out',
        text: 'plain reply',
        payload: {},
        createdAt: new Date(),
      },
    ]);
    const notes = await listLearnNotes(db, agent.id);
    const texts = notes.map((n) => n.key);
    expect(texts).toContain('returns are 30 days');
    expect(texts).toContain('shipping is flat-rate');
    expect(texts.filter((t) => t === 'returns are 30 days')).toHaveLength(1); // deduped
    expect(notes.every((n) => n.conversation_id === conv.id)).toBe(true);
    expect(notes.every((n) => !n.added)).toBe(true);

    // a covering knowledge entry flips added
    await db
      .update(agents)
      .set({ config: { knowledge: ['Shipping is always flat-rate $5.'] } })
      .where(eq(agents.id, agent.id));
    const after = await listLearnNotes(db, agent.id);
    expect(after.find((n) => n.key === 'shipping is flat-rate')?.added).toBe(true);
    expect(after.find((n) => n.key === 'returns are 30 days')?.added).toBe(false);
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
  });
});

describe('escalation-only clusters', () => {
  it('ignores "human please"-style requests — not knowledge gaps', async () => {
    await seedHandoff(agent.id, 'esc1', 'human please', 'hey there');
    await seedHandoff(agent.id, 'esc2', 'can i talk to a real person', 'on it');
    const gaps = await detectKnowledgeGaps(db, agent.id);
    for (const g of gaps) {
      expect(g.questions.join(' ')).not.toMatch(/human please|real person/);
    }
  });
});

describe('recheckGaps', () => {
  it('returns keys the LLM says are now covered by knowledge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"covered":[1]}' } }] }), {
          status: 200,
        }),
      ),
    );
    const gaps = await detectKnowledgeGaps(db, agent.id);
    const covered = await recheckGaps(
      db,
      { ...agent, config: { knowledge: ['Refunds are allowed within 30 days.'], llm: { api_key: 'test' } } },
      gaps,
    );
    expect(covered).toEqual([gaps[0].key]);
  });

  it('returns nothing with no knowledge or no LLM', async () => {
    const gaps = await detectKnowledgeGaps(db, agent.id);
    expect(await recheckGaps(db, { ...agent, config: {} }, gaps)).toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no llm')));
    expect(
      await recheckGaps(db, { ...agent, config: { knowledge: ['x'], llm: { api_key: 'test' } } }, gaps),
    ).toEqual([]);
  });
});

describe('resolved-by-behavior', () => {
  it('drops a cluster when a newer same-intent question was handled', async () => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    await seedHandoff(agent.id, 'p1', 'when will my package arrive?', 'check tracking', old);
    await seedHandoff(agent.id, 'p2', 'when will my package arrive?', 'check tracking', old);
    // the agent has since answered the same question on its own
    await seedHandled(agent.id, 'p3', 'when will my package arrive?');
    const gaps = await detectKnowledgeGaps(db, agent.id);
    expect(
      gaps.every((g) => !g.questions.some((q) => q.includes('package'))),
    ).toBe(true);
    // unrelated clusters unaffected
    expect(gaps.some((g) => g.questions[0].includes('refund'))).toBe(true);
  });

  it('keeps a cluster when the handled occurrence is older than the last escalation', async () => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    await seedHandled(agent.id, 'e1', 'how do i export my data?', old);
    await seedHandoff(agent.id, 'e2', 'how do i export my data?', 'settings → export');
    await seedHandoff(agent.id, 'e3', 'how do i export my data?', 'settings → export');
    const gaps = await detectKnowledgeGaps(db, agent.id);
    const hit = gaps.find((g) => g.questions.some((q) => q.includes('export')));
    expect(hit).toBeTruthy();
    expect(hit!.handled).toContain('how do i export my data?');
  });
});

describe('intent grouping', () => {
  it('merges same-intent clusters via the LLM pass', async () => {
    await db
      .update(agents)
      .set({ config: { llm: { api_key: 'test' } } })
      .where(eq(agents.id, agent.id));
    // two differently-phrased same-intent escalations — lexical singles
    await seedHandoff(agent.id, 'm1', 'what is my email?', 'you@x.com');
    await seedHandoff(agent.id, 'm2', 'what email do you have on file for me?', 'you@x.com');
    // merge whichever A-numbers correspond to the two email phrasings —
    // indices depend on seed order, so the mock parses the prompt
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_u: string, opts: { body: string }) => {
        const prompt = (JSON.parse(opts.body) as { messages: { content: string }[] })
          .messages[1].content;
        const nums = prompt
          .split('\n')
          .filter((l) => l.includes('email'))
          .map((l) => Number(l.split('.')[0]));
        const content = JSON.stringify({ merge: [nums], resolved: {} });
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200 },
        );
      }),
    );
    try {
      const gaps = await detectKnowledgeGaps(db, agent.id);
      const email = gaps.find((g) => g.questions.some((q) => q.includes('email')));
      expect(email).toBeTruthy();
      expect(email!.count).toBe(2);
      expect(email!.questions.length).toBe(2);
    } finally {
      await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
    }
  });

  it('drops a cluster the LLM maps to a newer handled question', async () => {
    await db
      .update(agents)
      .set({ config: { llm: { api_key: 'test' } } })
      .where(eq(agents.id, agent.id));
    const old = new Date(Date.now() - 2 * 86_400_000);
    await seedHandoff(agent.id, 'r1', 'can i change my plan?', 'yes via billing', old);
    await seedHandoff(agent.id, 'r2', 'can i change my plan?', 'yes via billing', old);
    // phrased differently but same intent — lexical alone would miss it
    await seedHandled(agent.id, 'r3', 'how do i switch my subscription tier?');
    const conv = vi.fn().mockImplementation(async (_u: string, opts: { body: string }) => {
      const prompt = (JSON.parse(opts.body) as { messages: { content: string }[] })
        .messages[1].content;
      const lines = prompt.split('\n');
      const aNum = Number(
        lines.find((l) => l.includes('change my plan'))!.split('.')[0],
      );
      const bNum = Number(
        lines.find((l) => l.includes('subscription tier'))!.split('.')[0],
      );
      const content = JSON.stringify({ merge: [], resolved: { [aNum]: [bNum] } });
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', conv);
    try {
      const gaps = await detectKnowledgeGaps(db, agent.id);
      expect(gaps.every((g) => !g.questions.some((q) => q.includes('plan')))).toBe(true);
    } finally {
      await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
    }
  });
});
