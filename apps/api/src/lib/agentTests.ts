import { desc, eq } from 'drizzle-orm';
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
  /** Source message id — lets the UI deep-link a test to the prompt it replays. */
  mid?: string;
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
  /** What grounded the reply — mirrors the conversation inspector payload. */
  context?: { prompt: 'custom' | 'default'; kb: string[]; knowledge: string[] };
}

/** The whole transcript as model-facing turns (no tail trim). */
export async function transcriptTurns(db: Db, convId: string): Promise<TestTurn[]> {
  // Most recent window — the rescues worth testing are usually at the tail.
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(400);
  rows.reverse();

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
      if (f?.action_request) turns.push({ role: 'agent', text: '(an action was submitted for teammate approval)', mid: m.id });
      else if (f?.action_result) turns.push({ role: 'agent', text: `(${m.text})`, mid: m.id });
      else if (f?.handoff_offer) turns.push({ role: 'agent', text: '(a human teammate was offered)', mid: m.id });
      else continue; // teach notes, approvals housekeeping — not in the transcript
      continue;
    }
    if (f?.action_request) turns.push({ role: 'agent', text: '(an action was submitted for teammate approval)', mid: m.id });
    else if (f?.action_result) turns.push({ role: 'agent', text: `(${m.text})`, mid: m.id });
    else if (f?.failure || f?.help_requested || f?.custom_alert)
      turns.push({ role: 'agent', text: '(passed to a human teammate)', mid: m.id });
    else if (f?.handoff_offer) turns.push({ role: 'agent', text: '(a human teammate was offered)', mid: m.id });
    else if (via === 'handoff')
      turns.push({ role: 'agent', text: '(the customer was told a human teammate is joining)', mid: m.id });
    else if (via === 'status') turns.push({ role: 'agent', text: '(a status update was sent to the customer)', mid: m.id });
    else if (m.direction === 'in') turns.push({ role: 'customer', text: m.text, mid: m.id });
    else if (m.direction === 'human') turns.push({ role: 'agent', text: `(human operator) ${m.text}`, mid: m.id });
    else turns.push({ role: 'agent', text: m.text, mid: m.id });
  }

  return turns;
}

/** Model-facing turns for a conversation, trimmed to end at the last
 *  customer turn — the same rules transcriptFor applies to stored
 *  messages, so a replayed test sees what the live agent saw. */
export async function turnsFromConversation(
  db: Db,
  convId: string,
  limit = 16,
): Promise<TestTurn[]> {
  const turns = await transcriptTurns(db, convId);
  // The replay answers the customer's last message — trailing agent turns
  // are the reply being regenerated, not context.
  const tail = turns.slice(-limit);
  while (tail.length && tail[tail.length - 1].role !== 'customer') tail.pop();
  return tail;
}

/** Agent turns that mean a human entered the loop — the signals transcript
 *  turns emit for escalation. Approval requests are excluded: gating an
 *  action is the product working as designed, not a failure. */
const RESCUE_MARKERS = [
  '(passed to a human teammate)',
  '(a human teammate was offered)',
  '(the customer was told a human teammate is joining)',
  '(human operator)',
];
const OFFER_MARKER = '(a human teammate was offered)';

/** Indices of customer turns that preceded a human intervention — each is
 *  a "formerly failed" prompt worth its own regression test. A customer
 *  turn is a checkpoint when a rescue marker appears before the next
 *  customer turn. Exception: a handoff *offer* only counts when it directly
 *  follows the customer turn — an agent reply in between means the agent
 *  answered and then courteously offered a human, which isn't a failure. */
export function checkpointIndices(turns: TestTurn[]): number[] {
  const points: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'customer') continue;
    for (let j = i + 1; j < turns.length && turns[j].role !== 'customer'; j++) {
      if (turns[j].text.startsWith(OFFER_MARKER) && j > i + 1) continue;
      if (RESCUE_MARKERS.some((m) => turns[j].text.startsWith(m))) {
        points.push(i);
        break;
      }
    }
  }
  return points;
}

const JUDGE_SYSTEM =
  'You are grading a hosted customer-support AI agent in a regression test. ' +
  'The operator saved a real conversation and stated what a good reply should do. ' +
  'Judge whether the reply accomplishes the expectation — wording does not need ' +
  'to match. The transcript shows prior context for realism: parenthesized ' +
  'markers like "(passed to a human teammate)" describe what happened EARLIER ' +
  'in the conversation, not the reply being graded — grade only the reply. ' +
  'Reply with ONLY a JSON object {"pass": true|false, "reason": "one sentence"}.';

/** Replay a saved test against the agent's CURRENT config — nothing executes
 *  (testRun stubs every tool call; gated calls are only proposed), nothing is
 *  delivered, and the only writes are usage metering + last_run on the test. */
export async function runAgentTest(
  db: Db,
  agent: AgentRow,
  test: AgentTestRow,
  opts?: { systemPrompt?: string },
): Promise<TestRunResult> {
  // A/B runs replay the suite against a candidate prompt without saving it.
  if (opts?.systemPrompt !== undefined) {
    agent = {
      ...agent,
      config: { ...(agent.config as Record<string, unknown>), system_prompt: opts.systemPrompt },
    };
  }
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
  // same grounding summary the "why this reply" inspector stamps
  const acfg = (agent.config ?? {}) as { knowledge?: string[]; system_prompt?: string };
  const context = {
    prompt: (acfg.system_prompt ? 'custom' : 'default') as 'custom' | 'default',
    kb: docs.map((d) => d.name),
    knowledge: (acfg.knowledge ?? []).slice(0, 20),
  };
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
  if (!gen.text?.trim())
    return {
      ...base,
      tools: gen.toolCalls,
      model: gen.model,
      context,
      reason: gen.toolCalls.length
        ? `agent produced no reply — it kept calling tools (${gen.toolCalls.map((t) => t.name).join(', ')}) without wrapping up`
        : 'agent produced no reply',
    };

  const reply = extractButtons(extractLearns(gen.text).text).text;
  const tag = controlTag(gen.text);

  if (!test.expectation.trim()) {
    return {
      ...base,
      reply,
      control: tag?.kind,
      tools: gen.toolCalls,
      model: gen.model,
      context,
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
    return { ...base, reply, control: tag?.kind, tools: gen.toolCalls, model: gen.model, context, reason: 'judge returned no verdict' };
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
      context,
    };
  } catch {
    return { ...base, reply, control: tag?.kind, tools: gen.toolCalls, model: gen.model, context, reason: 'judge verdict unreadable' };
  }
}

/** Draft a judge expectation for a rescued-conversation test — one cheap
 *  completion describing what a correct reply should have done at this
 *  checkpoint. Returns null when the agent has no LLM or the call fails;
 *  callers store the draft with expectationDraft=true so the UI marks it
 *  reviewable. */
export async function draftExpectation(
  db: Db,
  agent: AgentRow,
  turns: TestTurn[],
  originalReply: string | null,
): Promise<string | null> {
  let llm;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return null;
  }
  if (!llm.apiKey) return null;
  const transcript = turns
    .map((t) => `${t.role === 'customer' ? 'Customer' : 'Agent'}: ${t.text}`)
    .join('\n')
    .slice(0, 6000);
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
      ...(llm.headers ?? {}),
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 90,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You write regression-test expectations for a customer-service AI. ' +
            'Given a transcript ending where a human had to intervene, write one ' +
            'or two short sentences describing what a correct agent reply should ' +
            'do — concrete and checkable by a judge reading only the reply text ' +
            'and proposed tool calls. Example: "Acknowledges the failed payment ' +
            'and offers a retry link; does not promise a refund." No preamble.',
        },
        {
          role: 'user',
          content:
            `Transcript:\n${transcript}\n\n` +
            `What actually followed (usually the agent's failed reply or a handoff ` +
            `marker — the behavior to correct):\n${originalReply ?? '(none recorded)'}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const text = body?.choices?.[0]?.message?.content?.trim();
  return text ? text.slice(0, 1000) : null;
}
