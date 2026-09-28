import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentTests, agents, messages } from '../db/schema.js';
import { enabledBuiltins } from './builtinTools.js';
import { connectionSecrets } from './connections.js';
import {
  blessedUrlsFor,
  complete,
  controlTag,
  extractButtons,
  extractLearns,
  generateReply,
  llmFor,
  loadKnowledgeDocs,
  systemPrompt,
  type AgentRunContext,
  type InspectorToolCall,
} from './hostedAgent.js';
import { loadSecretsMap } from './secrets.js';
import { toolsFor } from './toolExec.js';
import { recordLlmUsage } from './usage.js';

type AgentRow = typeof agents.$inferSelect;
type AgentTestRow = typeof agentTests.$inferSelect;

/** One transcript turn as the model sees it — customer → user, agent and
 *  operator markers → assistant. Mirrors transcriptFor's mapping. */
export interface TestTurn {
  role: 'customer' | 'agent';
  text: string;
}

export interface TestRunResult {
  at: string;
  /** null = unrunnable (no LLM configured, empty reply, judge unreadable). */
  passed: boolean | null;
  reason: string;
  reply: string | null;
  /** Control tag the reply carried, if any (handoff / offer / cancel). */
  control?: 'handoff' | 'offer' | 'cancel';
  tools: InspectorToolCall[];
  model?: string;
}

/** Model-facing turns for a conversation — the same rules transcriptFor
 *  applies to stored messages, so a replayed test sees what the live agent
 *  saw. Internal event rows become the same neutral markers. */
export async function turnsFromConversation(
  db: Db,
  convId: string,
  limit = 16,
): Promise<TestTurn[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(asc(messages.createdAt))
    .limit(400);

  const turns: TestTurn[] = [];
  for (const m of rows) {
    if (!m.text) continue;
    const f = m.flags as {
      failure?: boolean;
      help_requested?: boolean;
      custom_alert?: boolean;
      handoff_offer?: boolean;
      handoff_cancelled?: boolean;
      action_request?: boolean;
      action_result?: boolean;
    };
    const via = (m.payload as { via?: string; internal?: boolean } | undefined)?.via;
    if ((m.payload as { internal?: boolean } | undefined)?.internal && m.direction === 'human') {
      // internal operator notes — the same markers transcriptFor emits
      if (f?.action_request) turns.push({ role: 'agent', text: '(an action was submitted for teammate approval)' });
      else if (f?.action_result) turns.push({ role: 'agent', text: `(${m.text})` });
      else if (f?.handoff_offer) turns.push({ role: 'agent', text: '(a human teammate was offered)' });
      else continue; // teach notes, approvals housekeeping — not in the transcript
      continue;
    }
    if (f?.action_request) turns.push({ role: 'agent', text: '(an action was submitted for teammate approval)' });
    else if (f?.action_result) turns.push({ role: 'agent', text: `(${m.text})` });
    else if (f?.failure || f?.help_requested || f?.custom_alert)
      turns.push({ role: 'agent', text: '(passed to a human teammate)' });
    else if (f?.handoff_offer) turns.push({ role: 'agent', text: '(a human teammate was offered)' });
    else if (via === 'handoff')
      turns.push({ role: 'agent', text: '(the customer was told a human teammate is joining)' });
    else if (via === 'status') turns.push({ role: 'agent', text: '(a status update was sent to the customer)' });
    else if (m.direction === 'in') turns.push({ role: 'customer', text: m.text });
    else if (m.direction === 'human') turns.push({ role: 'agent', text: `(human operator) ${m.text}` });
    else turns.push({ role: 'agent', text: m.text });
  }

  // The replay answers the customer's last message — trailing agent turns
  // are the reply being regenerated, not context.
  const tail = turns.slice(-limit);
  while (tail.length && tail[tail.length - 1].role !== 'customer') tail.pop();
  return tail;
}

const JUDGE_SYSTEM =
  'You are grading a hosted customer-support AI agent in a regression test. ' +
  'The operator saved a real conversation and stated what a good reply should do. ' +
  'Judge whether the reply accomplishes the expectation — wording does not need ' +
  'to match. Reply with ONLY a JSON object {"pass": true|false, "reason": "one sentence"}.';

/** Replay a saved test against the agent's CURRENT config — nothing executes
 *  (testRun stubs every tool call; gated calls are only proposed), nothing is
 *  delivered, and the only writes are usage metering + last_run on the test. */
export async function runAgentTest(
  db: Db,
  agent: AgentRow,
  test: AgentTestRow,
): Promise<TestRunResult> {
  const at = new Date().toISOString();
  const turns = (test.turns ?? []) as TestTurn[];
  const base: Omit<TestRunResult, 'passed' | 'reason'> & { passed: null; reason: string } = {
    at,
    passed: null,
    reason: '',
    reply: null,
    tools: [],
  };
  if (!turns.length) return { ...base, reason: 'test has no transcript turns' };

  const llm = await llmFor(db, agent);
  if (!llm.apiKey) return { ...base, reason: 'no LLM configured for this agent' };

  const docs = await loadKnowledgeDocs(db, agent.id);
  const secrets = {
    ...(await loadSecretsMap(db, agent.id)),
    ...(await connectionSecrets(db, agent.id)),
  };
  const ctx: AgentRunContext = {
    db,
    convId: test.sourceConversationId ?? '',
    workspaceId: agent.workspaceId,
    agent,
    testRun: true,
    suggesting: true,
  };
  const prompt = systemPrompt(agent, docs);
  const history = turns.map((t) => ({
    role: t.role === 'customer' ? 'user' : 'assistant',
    content: t.text,
  }));
  const cfg = (agent.config ?? {}) as { builtin_tools?: string[] };
  const gen = await generateReply(
    llm,
    prompt,
    history,
    blessedUrlsFor(agent, prompt, history),
    toolsFor(agent),
    secrets,
    ctx,
    enabledBuiltins(cfg.builtin_tools, agent.workspaceId),
  );
  if (gen.promptTokens || gen.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      conversationId: test.sourceConversationId,
      model: gen.model,
      capModel: llm.model,
      promptTokens: gen.promptTokens,
      completionTokens: gen.completionTokens,
      byok: llm.byok,
    });
  }
  if (!gen.text?.trim()) return { ...base, tools: gen.toolCalls, model: gen.model, reason: 'agent produced no reply' };

  const reply = extractButtons(extractLearns(gen.text).text).text;
  const tag = controlTag(gen.text);

  if (!test.expectation.trim()) {
    return {
      ...base,
      reply,
      control: tag?.kind,
      tools: gen.toolCalls,
      model: gen.model,
      reason: 'no expectation set — add one so runs can be judged',
    };
  }

  const transcript = turns.map((t) => `${t.role === 'customer' ? 'customer' : 'agent'}: ${t.text}`).join('\n');
  const toolNote = gen.toolCalls.length
    ? `\nTool calls made: ${gen.toolCalls.map((t) => `${t.name} (${t.outcome})`).join(', ')}`
    : '';
  const controlNote = tag ? `\nThe reply ended with a control tag: [${tag.kind.toUpperCase()}]` : '';
  const judged = await complete(
    llm,
    JUDGE_SYSTEM,
    [
      {
        role: 'user',
        content:
          `Conversation:\n${transcript}\n\n` +
          `The agent's reply:\n${reply}${controlNote}${toolNote}\n\n` +
          `Operator's expectation: ${test.expectation}`,
      },
    ],
  );
  if (judged.promptTokens || judged.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      conversationId: test.sourceConversationId,
      model: judged.model,
      capModel: llm.model,
      promptTokens: judged.promptTokens,
      completionTokens: judged.completionTokens,
      byok: llm.byok,
    });
  }

  const match = judged.text?.match(/\{[\s\S]*"pass"[\s\S]*\}/);
  if (!match) {
    return { ...base, reply, control: tag?.kind, tools: gen.toolCalls, model: gen.model, reason: 'judge returned no verdict' };
  }
  try {
    const v = JSON.parse(match[0]) as { pass?: boolean; reason?: string };
    return {
      at,
      passed: !!v.pass,
      reason: v.reason ?? '',
      reply,
      control: tag?.kind,
      tools: gen.toolCalls,
      model: gen.model,
    };
  } catch {
    return { ...base, reply, control: tag?.kind, tools: gen.toolCalls, model: gen.model, reason: 'judge verdict unreadable' };
  }
}
