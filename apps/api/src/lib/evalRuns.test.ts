import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { agents, agentTestRuns, agentTests, jobs, workspaces } from '../db/schema.js';
import { bus } from './bus.js';

vi.mock('./agentTests.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./agentTests.js')>();
  return {
    ...orig,
    runAgentTest: vi.fn(async (_db: Db, _agent: unknown, test: { id: string }) => ({
      at: new Date().toISOString(),
      passed: (globalThis as Record<string, unknown>).__verdicts
        ? ((globalThis as Record<string, boolean>).__verdicts[test.id] ?? true)
        : true,
      reason: 'mocked',
      reply: 'ok',
      tools: [],
      model: 'mock-model',
    })),
  };
});

const { detectRegression, sweepEvals, runScheduledEval } = await import('./evalRuns.js');

let db: Db;
let wsId: string;

const makeAgent = async (config?: Record<string, unknown>, hosted = true) => {
  const [a] = await db
    .insert(agents)
    .values({ workspaceId: wsId, name: 'Eval Bot', hosted, config: config ?? {} })
    .returning();
  return a;
};

const makeTest = async (agentId: string, name = 't') => {
  const [t] = await db
    .insert(agentTests)
    .values({
      workspaceId: wsId,
      agentId,
      name,
      turns: [{ role: 'customer', text: 'hi' }],
      expectation: 'be nice',
    })
    .returning();
  return t;
};

const setVerdicts = (v: Record<string, boolean>) => {
  (globalThis as Record<string, unknown>).__verdicts = v;
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  const [ws] = await db.insert(workspaces).values({ name: 'Eval WS' }).returning();
  wsId = ws.id;
});

describe('detectRegression', () => {
  const row = (testId: string, passed: boolean | null, testName = testId) => ({
    testId,
    testName,
    passed,
  });

  it('flags a pass→fail flip', () => {
    const reg = detectRegression([row('a', true), row('b', true)], [row('a', true), row('b', false)]);
    expect(reg).not.toBeNull();
    expect(reg!.flips).toEqual([{ testId: 'b', name: 'b' }]);
    expect(reg!.detail).toContain('newly failing: b');
  });

  it('does not re-alert on a steady-state failure', () => {
    expect(
      detectRegression([row('a', true), row('b', false)], [row('a', true), row('b', false)]),
    ).toBeNull();
  });

  it('flags a ≥20pp pass-rate drop without flips (new failing tests)', () => {
    const prev = [row('a', true), row('b', true), row('c', true), row('d', true), row('e', true)];
    const cur = [...prev.map((r) => row(r.testId, true)), row('f', false), row('g', false)];
    // 5/5 → 5/7 = 28pp drop, none of the failures existed in prev → no flips
    const reg = detectRegression(prev, cur);
    expect(reg).not.toBeNull();
    expect(reg!.flips).toEqual([]);
  });

  it('ignores a small rate drop', () => {
    const prev = Array.from({ length: 10 }, (_, i) => row(`t${i}`, true));
    const cur = [...prev.slice(0, 9).map((r) => row(r.testId, true)), row('new', false)];
    expect(detectRegression(prev, cur)).toBeNull(); // 10/10 → 9/10 = 10pp
  });

  it('flags a suite that became unrunnable', () => {
    const reg = detectRegression([row('a', true)], [row('a', null)]);
    expect(reg).not.toBeNull();
    expect(reg!.detail).toContain('unrunnable');
  });

  it('stays quiet when both batches are unrunnable', () => {
    expect(detectRegression([row('a', null)], [row('a', null)])).toBeNull();
  });
});

describe('sweepEvals', () => {
  it('enqueues eval.run for a due hosted agent', async () => {
    const agent = await makeAgent({ eval_interval_hours: 24 });
    expect(await sweepEvals(db)).toBe(1);
    const [job] = await db.select().from(jobs).where(eq(jobs.type, 'eval.run'));
    expect(job.payload).toMatchObject({ agentId: agent.id });
  });

  it('does not double-enqueue while a job is queued', async () => {
    // job from the previous test is still pending for this agent
    expect(await sweepEvals(db)).toBe(0);
  });

  it('skips agents without an interval or still inside it', async () => {
    const off = await makeAgent();
    await makeAgent({ eval_interval_hours: 24 }, false); // non-hosted
    const recent = await makeAgent({ eval_interval_hours: 24 });
    const t = await makeTest(recent.id);
    await db.insert(agentTestRuns).values({
      workspaceId: wsId,
      agentId: recent.id,
      testId: t.id,
      testName: t.name,
      batchId: crypto.randomUUID(),
      kind: 'scheduled',
      passed: true,
    });
    expect(off.config).not.toBeNull();
    expect(await sweepEvals(db)).toBe(0);
  });
});

describe('runScheduledEval', () => {
  it('records a batch, updates last_run, and alerts on regression', async () => {
    const agent = await makeAgent({ eval_interval_hours: 6 });
    const t1 = await makeTest(agent.id, 'refund');
    const t2 = await makeTest(agent.id, 'hours');
    const pub = vi.spyOn(bus, 'publish');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Batch 1 — all green, establishes the baseline
    setVerdicts({ [t1.id]: true, [t2.id]: true });
    const first = await runScheduledEval(db, wsId, agent.id);
    expect(first.batchId).toBeTruthy();
    expect(first.regression).toBeNull();
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('eval_regression'));

    // Batch 2 — t2 flips → regression alert
    setVerdicts({ [t1.id]: true, [t2.id]: false });
    const second = await runScheduledEval(db, wsId, agent.id);
    expect(second.regression).not.toBeNull();
    expect(second.regression!.flips[0]?.testId).toBe(t2.id);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('eval_regression'));
    expect(pub).toHaveBeenCalledWith(
      wsId,
      expect.objectContaining({ type: 'eval', data: expect.objectContaining({ regressed: true }) }),
    );

    // History: two scheduled batches of two rows each
    const rows = await db
      .select()
      .from(agentTestRuns)
      .where(eq(agentTestRuns.agentId, agent.id));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(2);

    const [updated] = await db.select().from(agentTests).where(eq(agentTests.id, t2.id));
    expect((updated.lastRun as { passed: boolean }).passed).toBe(false);

    // Batch 3 — still failing but no NEW regression → no alert
    errSpy.mockClear();
    setVerdicts({ [t1.id]: true, [t2.id]: false });
    const third = await runScheduledEval(db, wsId, agent.id);
    expect(third.regression).toBeNull();
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('eval_regression'));
    pub.mockRestore();
    errSpy.mockRestore();
  });

  it('no-ops on a missing or non-hosted agent', async () => {
    const ghost = await runScheduledEval(db, wsId, crypto.randomUUID());
    expect(ghost.batchId).toBeNull();
    const byok = await makeAgent({ eval_interval_hours: 6 }, false);
    expect((await runScheduledEval(db, wsId, byok.id)).batchId).toBeNull();
  });
});
