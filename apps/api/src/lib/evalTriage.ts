import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { agents, agentTestRuns, agentTests, evalSuggestions } from '../db/schema.js';
import {
  defaultPersona,
  llmFor,
  complete,
} from './hostedAgent.js';
import { judgeExpectation, runAgentTest, type TestTurn } from './agentTests.js';
import { recordRun } from './evalRuns.js';
import { notifyWorkspace } from './notify.js';
import { bus } from './bus.js';
import { recordLlmUsage } from './usage.js';

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof agentTestRuns.$inferSelect;

/** Triage is bounded on purpose: regressions are rare but suites aren't
 *  free — classify at most this many flips and verify at most this many
 *  candidates per batch. Overflow flips still get hypothesis rows. */
const MAX_FLIPS = 4;
const MAX_VERIFIED = 3;

export type SuggestionPatch =
  | { type: 'knowledge'; entry: string }
  | { type: 'system_prompt'; append: string }
  | { type: 'expectation'; test_id: string; expectation: string };

const CLASSIFY_SYSTEM =
  'You are triaging a regression in a hosted customer-support AI agent\'s test suite. ' +
  'A test that previously passed now fails. Classify the root cause and draft a fix.\n' +
  'Reply with ONLY a JSON object: {"kind": "knowledge_gap"|"prompt_drift"|"test_stale"|"other", ' +
  '"summary": "one sentence for the operator", "fix": "..."}\n' +
  '- knowledge_gap: the reply lacked a fact or policy. fix = ONE knowledge-base entry (1-2 ' +
  'sentences stating the fact itself — not "the agent should...").\n' +
  '- prompt_drift: the reply had the facts but wrong behavior, tone, or structure. fix = ONE ' +
  'short instruction sentence to append to the agent\'s prompt.\n' +
  '- test_stale: the reply is actually fine — the expectation is outdated because the product ' +
  'or policy changed. fix = the corrected expectation (a checkable bar, like the original).\n' +
  '- other: not mechanically fixable (tool wiring, ops issue, ambiguous). fix = ""';

interface Classification {
  kind: 'knowledge_gap' | 'prompt_drift' | 'test_stale' | 'other';
  summary: string;
  fix: string;
}

async function classifyFlip(
  db: Db,
  agent: AgentRow,
  test: typeof agentTests.$inferSelect,
  run: RunRow,
): Promise<Classification | null> {
  const llm = await llmFor(db, agent);
  const acfg = (agent.config ?? {}) as { knowledge?: string[]; system_prompt?: string };
  const res = await complete(llm, CLASSIFY_SYSTEM, [
    {
      role: 'user',
      content:
        `Test name: ${test.name}\n` +
        `Operator expectation: ${test.expectation}\n` +
        `The agent's reply:\n${(run.reply ?? '(no reply produced)').slice(0, 3000)}\n\n` +
        `Why the judge failed it: ${run.reason || '(none)'}\n` +
        `Agent has a custom system prompt: ${acfg.system_prompt ? 'yes' : 'no (default persona)'}\n` +
        `Knowledge entries configured: ${(acfg.knowledge ?? []).length}`,
    },
  ]);
  if (res.promptTokens || res.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      model: res.model,
      capModel: llm.model,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      byok: llm.byok,
    });
  }
  const match = res.text?.match(/\{[\s\S]*"kind"[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as { kind?: string; summary?: string; fix?: string };
    const kind = (
      ['knowledge_gap', 'prompt_drift', 'test_stale'] as const
    ).includes(v.kind as never)
      ? (v.kind as Classification['kind'])
      : 'other';
    return {
      kind,
      summary: (v.summary ?? '').slice(0, 500) || 'failing test needs review',
      fix: (v.fix ?? '').trim().slice(0, 2000),
    };
  } catch {
    return null;
  }
}

interface Verification {
  /** Judged pass-rate under the candidate. */
  passRate: number | null;
  /** Regressed batch's pass-rate — the bar to beat. */
  baselineRate: number | null;
  /** Flipped tests the candidate turned green again. */
  fixed: number;
  /** Previously-passing tests the candidate broke — any >0 sinks verification. */
  broke: number;
  /** Per-test candidate verdicts. */
  results: Map<string, boolean | null>;
}

/** Replay the WHOLE suite against a candidate config — the honest check.
 *  A fix that greens its target while breaking a neighbor is a trade, not
 *  a fix; the suite replay is what catches that before a human sees it.
 *  Candidate runs record as an 'ab' batch so history shows the experiment. */
async function verifyCandidate(
  db: Db,
  agent: AgentRow,
  tests: (typeof agentTests.$inferSelect)[],
  regressed: RunRow[],
  opts: { systemPrompt?: string; knowledge?: string[] },
): Promise<Verification> {
  const baseline = regressed.filter((r) => r.passed !== null);
  const baselineRate = baseline.length
    ? baseline.filter((r) => r.passed === true).length / baseline.length
    : null;
  const regressedByTest = new Map(regressed.map((r) => [r.testId, r.passed]));
  const verifyBatch = randomUUID();
  const results = new Map<string, boolean | null>();
  for (const test of tests) {
    const run = await runAgentTest(db, agent, test, opts).catch(() => null);
    results.set(test.id, run?.passed ?? null);
    if (run) await recordRun(db, { agent, test, result: run, batchId: verifyBatch, kind: 'ab' });
  }
  const judged = [...results.values()].filter((v) => v !== null);
  let fixed = 0;
  let broke = 0;
  for (const [testId, passed] of results) {
    const before = regressedByTest.get(testId);
    if (before === false && passed === true) fixed++;
    if (before === true && passed === false) broke++;
  }
  return {
    passRate: judged.length ? judged.filter((v) => v === true).length / judged.length : null,
    baselineRate,
    fixed,
    broke,
    results,
  };
}

/** Insert a suggestion row. Returns true when one was written. */
async function suggest(
  db: Db,
  agent: AgentRow,
  batchId: string,
  row: {
    testId?: string | null;
    kind: 'knowledge_gap' | 'prompt_drift' | 'test_stale' | 'hypothesis';
    summary: string;
    patch?: SuggestionPatch;
    verified?: { pass_rate: number | null; baseline_rate: number | null; broke: number };
  },
): Promise<boolean> {
  await db.insert(evalSuggestions).values({
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    batchId,
    testId: row.testId ?? null,
    kind: row.kind,
    summary: row.summary,
    patch: row.patch ?? null,
    verified: row.verified ?? null,
  });
  return true;
}

/**
 * The eval.triage job — runs after a scheduled batch regresses. For each
 * flipped test: classify the cause, draft a fix, and (when the fix is
 * mechanically applicable) VERIFY it by replaying the suite against the
 * candidate config before asking a human. Verified suggestions arrive
 * with evidence; the rest are stored as hypotheses. Idempotent per batch —
 * a retried job finds its rows and stops.
 */
export async function triageRegression(
  db: Db,
  workspaceId: string,
  agentId: string,
  batchId: string,
  heartbeat?: () => Promise<unknown>,
): Promise<number> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!agent?.hosted) return 0;

  // Idempotency — a reclaimed/retried job doesn't double-suggest.
  const [existing] = await db
    .select({ id: evalSuggestions.id })
    .from(evalSuggestions)
    .where(eq(evalSuggestions.batchId, batchId))
    .limit(1);
  if (existing) return 0;

  const llm = await llmFor(db, agent);
  if (!llm.apiKey) return 0;

  const curRows = await db
    .select()
    .from(agentTestRuns)
    .where(and(eq(agentTestRuns.batchId, batchId), ne(agentTestRuns.kind, 'ab')));
  if (!curRows.length) return 0;

  // Previous scheduled batch = the baseline this batch regressed against.
  const [prevAnchor] = await db
    .select({ batchId: agentTestRuns.batchId })
    .from(agentTestRuns)
    .where(
      and(
        eq(agentTestRuns.agentId, agent.id),
        eq(agentTestRuns.kind, 'scheduled'),
        ne(agentTestRuns.batchId, batchId),
      ),
    )
    .orderBy(desc(agentTestRuns.createdAt))
    .limit(1);
  const prevRows = prevAnchor
    ? await db
        .select()
        .from(agentTestRuns)
        .where(eq(agentTestRuns.batchId, prevAnchor.batchId))
    : [];
  const prevByTest = new Map(prevRows.map((r) => [r.testId, r]));

  const flips = curRows.filter(
    (r) => r.passed === false && prevByTest.get(r.testId)?.passed === true,
  );
  if (!flips.length) return 0;

  const tests = await db
    .select()
    .from(agentTests)
    .where(eq(agentTests.agentId, agent.id))
    .orderBy(asc(agentTests.createdAt));
  const testById = new Map(tests.map((t) => [t.id, t]));
  const acfg = (agent.config ?? {}) as { knowledge?: string[]; system_prompt?: string };
  const baseKnowledge = Array.isArray(acfg.knowledge) ? acfg.knowledge : [];
  const basePrompt = acfg.system_prompt || defaultPersona(agent.name);

  let created = 0;
  let verifiedCount = 0;
  let verifyBudget = MAX_VERIFIED;

  for (const flip of flips.slice(0, MAX_FLIPS)) {
    const test = testById.get(flip.testId);
    if (!test) continue;
    await heartbeat?.();
    const cls = await classifyFlip(db, agent, test, flip);

    if (!cls || cls.kind === 'other' || !cls.fix) {
      await suggest(db, agent, batchId, {
        testId: flip.testId,
        kind: 'hypothesis',
        summary: cls?.summary ?? `${test.name} flipped to failing — needs a human look`,
      });
      created++;
      continue;
    }

    if (cls.kind === 'test_stale') {
      // Cheapest verification: re-judge the STORED reply under the proposed
      // expectation. If it passes, the bar moved — not the agent.
      if (!flip.reply) {
        await suggest(db, agent, batchId, {
          testId: flip.testId,
          kind: 'hypothesis',
          summary: cls.summary,
        });
        created++;
        continue;
      }
      const transcript = ((test.turns ?? []) as TestTurn[])
        .map((t) => `${t.role === 'customer' ? 'customer' : 'agent'}: ${t.text}`)
        .join('\n');
      const verdict = await judgeExpectation(llm, {
        transcript,
        reply: flip.reply,
        expectation: cls.fix,
      });
      if (verdict && (verdict.promptTokens || verdict.completionTokens)) {
        await recordLlmUsage(db, {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          conversationId: test.sourceConversationId,
          model: verdict.model,
          capModel: llm.model,
          promptTokens: verdict.promptTokens,
          completionTokens: verdict.completionTokens,
          byok: llm.byok,
        });
      }
      const ok = verdict?.pass === true;
      if (ok) verifiedCount++;
      await suggest(db, agent, batchId, {
        testId: flip.testId,
        kind: 'test_stale',
        summary: cls.summary,
        patch: { type: 'expectation', test_id: test.id, expectation: cls.fix },
        // Not a suite rate — the stored reply passed a re-judge under the
        // proposed expectation. The UI labels this kind specially.
        verified: ok ? { pass_rate: null, baseline_rate: null, broke: 0 } : undefined,
      });
      created++;
      continue;
    }

    // knowledge_gap / prompt_drift — verify against the whole suite.
    if (verifyBudget <= 0) {
      await suggest(db, agent, batchId, {
        testId: flip.testId,
        kind: 'hypothesis',
        summary: cls.summary,
      });
      created++;
      continue;
    }
    verifyBudget--;
    const opts =
      cls.kind === 'knowledge_gap'
        ? { knowledge: [...baseKnowledge, cls.fix] }
        : { systemPrompt: `${basePrompt}\n\n${cls.fix}` };
    const v = await verifyCandidate(db, agent, tests, curRows, opts);
    await heartbeat?.();
    const ok = v.results.get(test.id) === true && v.broke === 0;
    if (ok) verifiedCount++;
    await suggest(db, agent, batchId, {
      testId: flip.testId,
      kind: cls.kind,
      summary: cls.summary,
      patch:
        cls.kind === 'knowledge_gap'
          ? { type: 'knowledge', entry: cls.fix }
          : { type: 'system_prompt', append: cls.fix },
      verified: ok
        ? { pass_rate: v.passRate, baseline_rate: v.baselineRate, broke: v.broke }
        : undefined,
    });
    created++;
  }

  if (created) {
    await notifyWorkspace(
      db,
      agent.workspaceId,
      {
        title: `Eval triage · ${agent.name}`,
        body: verifiedCount
          ? `${verifiedCount} verified fix${verifiedCount === 1 ? '' : 'es'} drafted for the regression — review on the Tests tab`
          : `${created} suggestion${created === 1 ? '' : 's'} drafted for the regression (none verified) — review on the Tests tab`,
        url: `/agents/${agent.id}?tab=tests`,
      },
      { agentId: agent.id, event: 'eval' },
    );
    bus.publish(agent.workspaceId, {
      type: 'eval',
      data: { agent_id: agent.id, batch_id: batchId, regressed: true, triaged: true },
    });
  }
  return created;
}

/** Apply an approved suggestion patch. Returns false when the patch shape is
 *  unknown or the target drifted away (e.g. expectation test deleted). */
export async function applySuggestion(
  db: Db,
  agent: AgentRow,
  patch: SuggestionPatch,
): Promise<boolean> {
  const cfg = { ...((agent.config ?? {}) as Record<string, unknown>) };
  if (patch.type === 'knowledge') {
    const knowledge = Array.isArray(cfg.knowledge) ? [...(cfg.knowledge as string[])] : [];
    if (!knowledge.includes(patch.entry)) knowledge.push(patch.entry);
    cfg.knowledge = knowledge;
    await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
    return true;
  }
  if (patch.type === 'system_prompt') {
    const cur = typeof cfg.system_prompt === 'string' ? cfg.system_prompt : '';
    // Append the delta to whatever the prompt is NOW — verification proved
    // the instruction; the base may have drifted since triage ran.
    const base = cur || defaultPersona(agent.name);
    cfg.system_prompt = `${base}\n\n${patch.append}`;
    await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
    return true;
  }
  if (patch.type === 'expectation') {
    const [t] = await db
      .update(agentTests)
      .set({ expectation: patch.expectation, expectationDraft: true })
      .where(and(eq(agentTests.id, patch.test_id), eq(agentTests.agentId, agent.id)))
      .returning({ id: agentTests.id });
    return Boolean(t);
  }
  return false;
}
