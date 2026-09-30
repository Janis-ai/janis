import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { agents, agentTestRuns, agentTests } from '../db/schema.js';
import { runAgentTest, type TestRunResult } from './agentTests.js';
import { notifyWorkspace } from './notify.js';
import { opsAlert } from './opsAlert.js';
import { enqueueJob } from './jobs.js';
import { bus } from './bus.js';

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof agentTestRuns.$inferSelect;
export type EvalKind = 'manual' | 'ab' | 'scheduled';

/** Persist one test execution — every run path (single, run-all, A/B,
 *  scheduled) records here so history and diffs have a uniform source. */
export async function recordRun(
  db: Db,
  run: {
    agent: { id: string; workspaceId: string };
    test: { id: string; name: string };
    result: TestRunResult;
    batchId: string;
    kind: EvalKind;
  },
): Promise<void> {
  await db.insert(agentTestRuns).values({
    workspaceId: run.agent.workspaceId,
    agentId: run.agent.id,
    testId: run.test.id,
    testName: run.test.name,
    batchId: run.batchId,
    kind: run.kind,
    passed: run.result.passed,
    reason: run.result.reason,
    reply: run.result.reply,
    model: run.result.model,
  });
}

export function evalIntervalHours(agent: AgentRow): number | null {
  const h = (agent.config as { eval_interval_hours?: number } | null)?.eval_interval_hours;
  return typeof h === 'number' && h >= 1 ? h : null;
}

/**
 * Scheduling half of the eval loop — called under the sweeper leader lock.
 * For each hosted agent with config.eval_interval_hours set, enqueue one
 * eval.run job when the newest scheduled batch is older than the interval
 * (or none exists). A still-queued/running eval.run job for the agent skips
 * re-enqueue — the LLM work itself lives on the jobs path.
 */
export async function sweepEvals(db: Db): Promise<number> {
  const agentRows = await db.select().from(agents);
  let enqueued = 0;
  for (const agent of agentRows) {
    if (!agent.hosted) continue;
    const hours = evalIntervalHours(agent);
    if (!hours) continue;

    const [latest] = await db
      .select({ createdAt: agentTestRuns.createdAt })
      .from(agentTestRuns)
      .where(and(eq(agentTestRuns.agentId, agent.id), eq(agentTestRuns.kind, 'scheduled')))
      .orderBy(desc(agentTestRuns.createdAt))
      .limit(1);
    if (latest && latest.createdAt.getTime() > Date.now() - hours * 3_600_000) continue;

    const raw = (await db.execute(sql`
      select 1 from jobs
      where type = 'eval.run' and status in ('pending', 'running')
        and payload->>'agentId' = ${agent.id}
      limit 1
    `)) as unknown;
    const queued = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) ?? [];
    if (queued.length) continue;

    await enqueueJob(db, {
      workspaceId: agent.workspaceId,
      type: 'eval.run',
      payload: { agentId: agent.id },
    });
    enqueued++;
  }
  return enqueued;
}

export interface EvalRegression {
  /** Tests that passed last batch and fail now. */
  flips: { testId: string; name: string }[];
  prevRate: number | null;
  curRate: number | null;
  detail: string;
}

const RATE_DROP_THRESHOLD = 0.2;

function passRate(rows: Pick<RunRow, 'passed'>[]): number | null {
  const judged = rows.filter((r) => r.passed !== null);
  if (!judged.length) return null;
  return judged.filter((r) => r.passed === true).length / judged.length;
}

/**
 * Adjacent-batch regression check. Regressed = any test flipped pass→fail,
 * or the judged pass-rate dropped ≥20pp, or the suite became unrunnable
 * (was judged, now nothing scores). Steady-state failures don't re-alert:
 * a still-red test isn't a flip against a previous batch that also had it red.
 */
export function detectRegression(
  prev: Pick<RunRow, 'testId' | 'testName' | 'passed'>[],
  cur: Pick<RunRow, 'testId' | 'testName' | 'passed'>[],
): EvalRegression | null {
  if (!cur.length) return null;
  const prevByTest = new Map(prev.map((r) => [r.testId, r]));
  const flips = cur
    .filter((r) => r.passed === false && prevByTest.get(r.testId)?.passed === true)
    .map((r) => ({ testId: r.testId, name: r.testName }));

  const prevRate = passRate(prev);
  const curRate = passRate(cur);
  const counted = (rows: typeof cur) =>
    `${rows.filter((r) => r.passed === true).length}/${rows.filter((r) => r.passed !== null).length}`;

  if (curRate === null) {
    if (prevRate === null) return null; // suite was already unrunnable
    return {
      flips,
      prevRate,
      curRate,
      detail: `eval suite unrunnable — no tests could be judged (was ${counted(prev)} passing)`,
    };
  }
  const dropped = prevRate !== null && prevRate - curRate >= RATE_DROP_THRESHOLD;
  if (!flips.length && !dropped) return null;
  const parts = [`${counted(cur)} tests passing`];
  if (prevRate !== null) parts.push(`was ${counted(prev)}`);
  if (flips.length) parts.push(`newly failing: ${flips.map((f) => f.name).join(', ')}`);
  return { flips, prevRate, curRate, detail: parts.join(' — ') };
}

/**
 * The eval.run job: replay the whole suite against the agent's current
 * config, record the batch, compare to the previous scheduled batch, and
 * alert the workspace on a regression. `heartbeat` runs between tests so a
 * long suite keeps its claimed job row fresh against the 5-minute reclaim.
 */
export async function runScheduledEval(
  db: Db,
  workspaceId: string,
  agentId: string,
  heartbeat?: () => Promise<unknown>,
): Promise<{ batchId: string | null; regression: EvalRegression | null }> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!agent?.hosted) return { batchId: null, regression: null };

  const tests = await db
    .select()
    .from(agentTests)
    .where(eq(agentTests.agentId, agent.id))
    .orderBy(asc(agentTests.createdAt));
  if (!tests.length) return { batchId: null, regression: null };

  // Baseline = the newest scheduled batch BEFORE this one exists.
  const [prevAnchor] = await db
    .select({ batchId: agentTestRuns.batchId })
    .from(agentTestRuns)
    .where(and(eq(agentTestRuns.agentId, agent.id), eq(agentTestRuns.kind, 'scheduled')))
    .orderBy(desc(agentTestRuns.createdAt))
    .limit(1);
  const prevRows = prevAnchor
    ? await db
        .select()
        .from(agentTestRuns)
        .where(and(eq(agentTestRuns.batchId, prevAnchor.batchId), ne(agentTestRuns.kind, 'ab')))
    : [];

  const batchId = randomUUID();
  for (const test of tests) {
    const result = await runAgentTest(db, agent, test);
    await db.update(agentTests).set({ lastRun: result as never }).where(eq(agentTests.id, test.id));
    await recordRun(db, { agent, test, result, batchId, kind: 'scheduled' });
    await heartbeat?.();
  }

  const curRows = await db
    .select()
    .from(agentTestRuns)
    .where(eq(agentTestRuns.batchId, batchId));
  const regression = detectRegression(prevRows, curRows);

  if (regression) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: `janis.alert eval_regression: ${agent.name} — ${regression.detail}`,
        alert: 'eval_regression',
        agentId: agent.id,
        batchId,
      }),
    );
    opsAlert(`🚨 janis: eval regression — ${agent.name}: ${regression.detail}`);
    await notifyWorkspace(
      db,
      agent.workspaceId,
      {
        title: `Eval regression · ${agent.name}`,
        body: regression.detail,
        url: `/agents/${agent.id}?tab=tests`,
      },
      { agentId: agent.id, event: 'eval' },
    );
  }
  bus.publish(agent.workspaceId, {
    type: 'eval',
    data: { agent_id: agent.id, batch_id: batchId, regressed: !!regression },
  });
  return { batchId, regression };
}
