import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, agentTestRuns, agentTests, evalSuggestions, workspaces } from '../db/schema.js';

// Mockable state — set per test:
//   __classify:   JSON text the classifier completion returns (queue, one per call)
//   __verdicts:   baseline runAgentTest verdicts by test id
//   __candidateVerdicts: verdicts when opts are passed (the candidate replay)
//   __rejudge:    judgeExpectation's return for the test_stale path
const g = globalThis as Record<string, unknown>;

vi.mock('./hostedAgent.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./hostedAgent.js')>();
  return {
    ...orig,
    llmFor: vi.fn(async () => ({
      apiKey: 'k',
      baseUrl: 'https://llm.test',
      model: 'test-model',
      byok: false,
    })),
    complete: vi.fn(async () => ({
      text: (g.__classify as string[] | undefined)?.shift() ?? null,
      promptTokens: 10,
      completionTokens: 5,
      model: 'test-model',
      toolCalls: [],
      widgets: [],
      producedIds: new Set(),
    })),
  };
});

vi.mock('./agentTests.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./agentTests.js')>();
  return {
    ...orig,
    runAgentTest: vi.fn(
      async (_db: Db, _agent: unknown, test: { id: string }, opts?: unknown) => ({
        at: new Date().toISOString(),
        passed: opts
          ? ((g.__candidateVerdicts as Record<string, boolean> | undefined)?.[test.id] ?? null)
          : ((g.__verdicts as Record<string, boolean> | undefined)?.[test.id] ?? true),
        reason: 'mocked',
        reply: 'ok',
        tools: [],
        model: 'mock-model',
      }),
    ),
    judgeExpectation: vi.fn(async () => g.__rejudge ?? null),
  };
});

const { triageRegression, applySuggestion } = await import('./evalTriage.js');

let db: Db;
let wsId: string;
let agent: typeof agents.$inferSelect;
let t1: typeof agentTests.$inferSelect;
let t2: typeof agentTests.$inferSelect;

const run = (
  batchId: string,
  testId: string,
  passed: boolean | null,
  kind: 'scheduled' | 'ab' = 'scheduled',
) =>
  db.insert(agentTestRuns).values({
    workspaceId: wsId,
    agentId: agent.id,
    testId,
    testName: 't',
    batchId,
    kind,
    passed,
    reason: passed === false ? 'missed the mark' : '',
    reply: passed === false ? 'bad reply' : 'good reply',
    model: 'm',
  });

const suggestionsFor = (batchId: string) =>
  db.select().from(evalSuggestions).where(eq(evalSuggestions.batchId, batchId));

const freshAgent = async () =>
  (await db.select().from(agents).where(eq(agents.id, agent.id)))[0];

const resetMocks = () => {
  g.__classify = [];
  g.__verdicts = {};
  g.__candidateVerdicts = undefined;
  g.__rejudge = null;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'W' }).returning();
  wsId = ws.id;
  [agent] = await db
    .insert(agents)
    .values({ workspaceId: wsId, name: 'Eval Bot', hosted: true, config: {} })
    .returning();
  [t1] = await db
    .insert(agentTests)
    .values({
      workspaceId: wsId,
      agentId: agent.id,
      name: 'pricing q',
      turns: [{ role: 'customer', text: 'how much?' }],
      expectation: 'mentions the $29 plan',
    })
    .returning();
  [t2] = await db
    .insert(agentTests)
    .values({
      workspaceId: wsId,
      agentId: agent.id,
      name: 'greeting',
      turns: [{ role: 'customer', text: 'hi' }],
      expectation: 'greets back',
    })
    .returning();
});

/** prev batch all-green → cur batch regressed (t1 flipped). The freshly
 *  inserted prev batch is the newest scheduled batch, so it's the baseline
 *  triage diffs against — earlier tests' rows can't contaminate it. */
const seedRegression = async (flipT2 = false) => {
  const prev = randomUUID();
  await run(prev, t1.id, true);
  await run(prev, t2.id, true);
  const cur = randomUUID();
  await run(cur, t1.id, false);
  await run(cur, t2.id, !flipT2);
  return cur;
};

describe('triageRegression', () => {
  it('verifies a knowledge-gap fix that greens the suite', async () => {
    resetMocks();
    const batch = await seedRegression();
    g.__classify = [
      '{"kind":"knowledge_gap","summary":"reply lacked the new price","fix":"The Starter plan is $29/mo and includes 2,000 messages."}',
    ];
    g.__candidateVerdicts = { [t1.id]: true, [t2.id]: true };
    const n = await triageRegression(db, wsId, agent.id, batch);
    expect(n).toBe(1);
    const [s] = await suggestionsFor(batch);
    expect(s.kind).toBe('knowledge_gap');
    expect((s.patch as { entry: string }).entry).toContain('$29/mo');
    expect(s.verified).not.toBeNull();
    expect(s.status).toBe('pending');
  });

  it('does NOT verify a prompt fix that breaks a neighboring test', async () => {
    resetMocks();
    const batch = await seedRegression();
    g.__classify = [
      '{"kind":"prompt_drift","summary":"too terse","fix":"Always state the exact price including billing period."}',
    ];
    g.__candidateVerdicts = { [t1.id]: true, [t2.id]: false };
    await triageRegression(db, wsId, agent.id, batch);
    const [s] = await suggestionsFor(batch);
    expect(s.kind).toBe('prompt_drift');
    expect(s.verified).toBeNull(); // fixed t1 but broke t2 — a trade, not a fix
    expect((s.patch as { append: string }).append).toContain('price');
  });

  it('verifies test_stale by re-judging the stored reply, no suite replay', async () => {
    resetMocks();
    const batch = await seedRegression();
    g.__classify = [
      '{"kind":"test_stale","summary":"price changed, expectation outdated","fix":"mentions the $39 plan"}',
    ];
    g.__rejudge = { pass: true, reason: 'reply now correct', promptTokens: 1, completionTokens: 1, model: 'm' };
    await triageRegression(db, wsId, agent.id, batch);
    const [s] = await suggestionsFor(batch);
    expect(s.kind).toBe('test_stale');
    expect(s.verified).not.toBeNull();
    expect((s.patch as { test_id: string }).test_id).toBe(t1.id);
  });

  it('stores hypothesis rows when the cause is not mechanical', async () => {
    resetMocks();
    const batch = await seedRegression();
    g.__classify = ['{"kind":"other","summary":"tool wiring looks broken","fix":""}'];
    await triageRegression(db, wsId, agent.id, batch);
    const [s] = await suggestionsFor(batch);
    expect(s.kind).toBe('hypothesis');
    expect(s.patch).toBeNull();
    expect(s.verified).toBeNull();
  });

  it('is idempotent per batch and no-ops without flips', async () => {
    resetMocks();
    const batch = await seedRegression();
    g.__classify = ['{"kind":"other","summary":"x","fix":""}'];
    expect(await triageRegression(db, wsId, agent.id, batch)).toBe(1);
    expect(await triageRegression(db, wsId, agent.id, batch)).toBe(0);
    // a batch with no flips (all passed) produces nothing
    const green = randomUUID();
    await run(green, t1.id, true);
    await run(green, t2.id, true);
    expect(await triageRegression(db, wsId, agent.id, green)).toBe(0);
  });
});

describe('applySuggestion', () => {
  it('appends a knowledge entry to config.knowledge', async () => {
    const ok = await applySuggestion(db, await freshAgent(), {
      type: 'knowledge',
      entry: 'The Starter plan is $29/mo.',
    });
    expect(ok).toBe(true);
    const a = await freshAgent();
    expect((a.config as { knowledge: string[] }).knowledge).toContain('The Starter plan is $29/mo.');
  });

  it('appends prompt instructions to the default persona when no custom prompt', async () => {
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
    const ok = await applySuggestion(db, await freshAgent(), {
      type: 'system_prompt',
      append: 'Always state prices with the billing period.',
    });
    expect(ok).toBe(true);
    const a = await freshAgent();
    const prompt = (a.config as { system_prompt: string }).system_prompt;
    expect(prompt).toContain('You are Eval Bot'); // default persona preserved
    expect(prompt).toContain('billing period');
  });

  it('appends to an existing custom prompt rather than replacing it', async () => {
    await db
      .update(agents)
      .set({ config: { system_prompt: 'You are a terse bot.' } })
      .where(eq(agents.id, agent.id));
    await applySuggestion(db, await freshAgent(), { type: 'system_prompt', append: 'Be warm.' });
    const a = await freshAgent();
    expect((a.config as { system_prompt: string }).system_prompt).toBe(
      'You are a terse bot.\n\nBe warm.',
    );
    // reset for any later tests
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agent.id));
  });

  it('rewrites the expectation on the target test only', async () => {
    const ok = await applySuggestion(db, await freshAgent(), {
      type: 'expectation',
      test_id: t1.id,
      expectation: 'mentions the $39 plan',
    });
    expect(ok).toBe(true);
    const [t] = await db.select().from(agentTests).where(eq(agentTests.id, t1.id));
    expect(t.expectation).toBe('mentions the $39 plan');
    expect(t.expectationDraft).toBe(true);
    // foreign test id → 409 path
    expect(
      await applySuggestion(db, await freshAgent(), {
        type: 'expectation',
        test_id: randomUUID(),
        expectation: 'x',
      }),
    ).toBe(false);
  });
});
