import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agentTests,
  agents,
  conversations,
  knowledgeFiles,
  messages,
} from '../db/schema.js';
import { enabledBuiltins } from './builtinTools.js';
import { connectionSecrets } from './connections.js';
import {
  blessedUrlsFor,
  complete,
  controlTag,
  defaultPersona,
  extractButtons,
  extractLearns,
  generateReply,
  llmFor,
  knowledgeQueryFor,
  loadKnowledgeDocs,
  notesReserved,
  systemPrompt,
  verifiedIdentityFor,
  withWorkspaceDefaults,
  type AgentRunContext,
  type InspectorToolCall,
  type LlmSettings,
} from './hostedAgent.js';
import { loadSecretsMap } from './secrets.js';
import { freshShopifyToken } from './shopifyToken.js';
import { toolsFor } from './toolExec.js';
import { recordLlmUsage } from './usage.js';

type AgentRow = typeof agents.$inferSelect;
type AgentTestRow = typeof agentTests.$inferSelect;
type ConvRow = typeof conversations.$inferSelect;

/** Session state snapshotted when a test is saved from a real conversation —
 *  replayContextFor writes it, runAgentTest hydrates the run with it so the
 *  replay sees what the live turn saw instead of bare text turns. */
export interface ReplayContext {
  v: 1;
  captured_at: string;
  /** userProfile at save — rebuilt into the prompt's conversationContext. */
  profile: Record<string, unknown> | null;
  /** conv.externalId — the prefix carries the channel for prompt parity. */
  external_id: string | null;
  agent_summary: string | null;
  /** verifiedIdentityFor at save — identity-gated tools then behave as live. */
  identity: { emails: string[]; ids: string[]; operator: boolean };
  /** conv.state at save — 'needs_human' switches the prompt's escalation
   *  context line ("a human was already notified — keep helping"). Older
   *  snapshots lack it; runAgentTest derives it from the transcript then. */
  state?: string | null;
  /** The triggering reply's calls — inspector key → stored result/outcome. */
  calls: { key: string; result: string; outcome: InspectorToolCall['outcome'] }[];
}

/** Assemble the snapshot from already-loaded parts — the route batches the
 *  identity resolution and reply-message reads across a transcript's
 *  checkpoints, then calls this once per saved test. */
export function replayContextFrom(
  conv: ConvRow,
  identity: { emails: Set<string>; ids: Set<string>; operator: boolean },
  replyPayload: unknown,
): ReplayContext {
  const calls: ReplayContext['calls'] = [];
  const tools =
    ((replyPayload as { inspector?: { tools?: InspectorToolCall[] } } | undefined)?.inspector
      ?.tools ?? []) as InspectorToolCall[];
  for (const t of tools) {
    if (t.key && t.result != null) calls.push({ key: t.key, result: t.result, outcome: t.outcome });
  }
  return {
    v: 1,
    captured_at: new Date().toISOString(),
    profile: (conv.userProfile as Record<string, unknown> | null) ?? null,
    external_id: conv.externalId ?? null,
    agent_summary: conv.agentSummary ?? null,
    identity: { emails: [...identity.emails], ids: [...identity.ids], operator: identity.operator },
    state: conv.state ?? null,
    calls,
  };
}

/** Snapshot what a saved test needs to replay faithfully: the tool calls the
 *  reply message ran (key → result, recorded on the inspector since 0116),
 *  the customer's verified identity at save time, and the profile/channel/
 *  summary the prompt builder saw. replyMessageId is the message right after
 *  the trigger — its inspector carries the turn's tool calls. */
export async function replayContextFor(
  db: Db,
  conv: ConvRow,
  workspaceId: string,
  replyMessageId?: string | null,
): Promise<ReplayContext> {
  let payload: unknown;
  if (replyMessageId) {
    const [msg] = await db
      .select({ payload: messages.payload })
      .from(messages)
      .where(eq(messages.id, replyMessageId))
      .limit(1);
    payload = msg?.payload;
  }
  const id = await verifiedIdentityFor(db, conv, workspaceId);
  return replayContextFrom(conv, id, payload);
}

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
  control?: 'handoff' | 'offer' | 'cancel' | 'end';
  /** Simulated human teammate's reply — runs can't produce a real human,
   *  so after an escalation (or inside an already-escalated thread) the
   *  sim plays the teammate who would have stepped in. */
  humanReply?: string;
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
    // Internal audit lines ('Assigned to X (rule)', 'Status: agent → needs
    // human', 'SLA breach — …') are bookkeeping for operators, not turns —
    // transcriptFor drops them the same way; fed to a replayed prompt or a
    // judge they read as agent output and corrupt both.
    if (m.direction === 'out' && (m.payload as { internal?: boolean } | undefined)?.internal)
      continue;
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

/** The escalation state a transcript implies — what live computes from
 *  conv.state + the alerts table, recovered from the marker turns so a
 *  replayed test prompts the agent with the same "a human is in the loop"
 *  context production had. Human-spoke is tracked separately: an operator
 *  message in history means a real human already addressed the customer,
 *  which the reply should treat as said (don't repeat, don't re-offer). */
export function escalationOf(turns: TestTurn[]): {
  needsHuman: boolean;
  pendingOffer: boolean;
  offerMade: boolean;
  humanSpoke: boolean;
} {
  let needsHuman = false;
  let offerMade = false;
  let humanSpoke = false;
  for (const t of turns) {
    if (t.text.startsWith(OFFER_MARKER)) offerMade = true;
    else if (
      t.text.startsWith('(passed to a human teammate)') ||
      t.text.startsWith('(the customer was told a human teammate is joining)')
    )
      needsHuman = true;
    else if (t.text.startsWith('(human operator)')) {
      needsHuman = true;
      humanSpoke = true;
    }
  }
  // The customer's newest message answers a pending offer only when the
  // offer marker sits right before it — an older offer already resolved.
  let pendingOffer = false;
  const last = turns[turns.length - 1];
  if (last?.role === 'customer' && turns[turns.length - 2]?.text.startsWith(OFFER_MARKER))
    pendingOffer = true;
  return { needsHuman, pendingOffer, offerMade, humanSpoke };
}

/** Shapes systemNote emits for internal audit lines — matched only for
 *  turns whose mid no longer resolves (the flag check is authoritative
 *  when the source row exists). */
const INTERNAL_TURN =
  /^(Assigned to .+\(.+\)|.+ tried to assign .+ — already owned by .+|Tagged ".+" \(.+\)|Status: \w+ → .+|SLA breach\b)/;

/** Drop turns whose source message was an internal audit row — tests saved
 *  before transcriptTurns filtered them carry 'Assigned to…'/'SLA breach'
 *  lines as agent turns. One batched lookup cleans them at run and read
 *  time without rewriting stored data. Turns without a mid (hand-built,
 *  inline saves) pass through untouched. */
export async function stripInternalTurns(db: Db, turns: TestTurn[]): Promise<TestTurn[]> {
  const mids = turns.map((t) => t.mid).filter((m): m is string => !!m);
  if (!mids.length) return turns;
  const rows = await db
    .select({ id: messages.id, direction: messages.direction, payload: messages.payload })
    .from(messages)
    .where(inArray(messages.id, mids));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return turns.filter((t) => {
    if (!t.mid) return true;
    const row = byId.get(t.mid);
    if (!row) return !INTERNAL_TURN.test(t.text);
    return !(
      row.direction === 'out' && (row.payload as { internal?: boolean } | null)?.internal === true
    );
  });
}

const JUDGE_SYSTEM =
  'You are grading a hosted customer-support AI agent in a regression test. ' +
  'The operator saved a real conversation and stated what a good reply should do. ' +
  'Judge whether the reply accomplishes the expectation — wording does not need ' +
  'to match. The transcript shows prior context for realism: parenthesized ' +
  'markers like "(passed to a human teammate)" describe what happened EARLIER ' +
  'in the conversation, not the reply being graded — grade only the reply. ' +
  'This is a simulation: tools do not really execute and no real human acts. ' +
  'Turns prefixed "(human operator)" were written by a human teammate, not by ' +
  'the agent. A control tag like [HANDOFF] IS the agent\'s way of summoning a ' +
  'human — emitting it completes that action; don\'t fail a reply because a ' +
  'literal human didn\'t appear, and don\'t require real-world outcomes a ' +
  'simulation can\'t produce (specific wait times, external status). ' +
  'Reply with ONLY a JSON object {"pass": true|false, "reason": "one sentence"}.';

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
  promptTokens: number;
  completionTokens: number;
  /** Wire id of the model that judged — bill against this. */
  model: string;
}

/** The suite judge, extracted so regression triage can re-judge a stored
 *  reply under a candidate expectation without replaying the agent (the
 *  test_stale check — "is this reply actually fine now, the bar just moved?"). */
export async function judgeExpectation(
  llm: LlmSettings,
  input: {
    transcript: string;
    reply: string;
    expectation: string;
    toolNote?: string;
    controlNote?: string;
  },
): Promise<JudgeVerdict | null> {
  const judged = await complete(llm, JUDGE_SYSTEM, [
    {
      role: 'user',
      content:
        `Conversation:\n${input.transcript}\n\n` +
        `The agent's reply:\n${input.reply}${input.controlNote ?? ''}${input.toolNote ?? ''}\n\n` +
        `Operator's expectation: ${input.expectation}`,
    },
  ]);
  const match = judged.text?.match(/\{[\s\S]*"pass"[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as { pass?: boolean; reason?: string };
    return {
      pass: !!v.pass,
      reason: v.reason ?? '',
      promptTokens: judged.promptTokens,
      completionTokens: judged.completionTokens,
      model: judged.model,
    };
  } catch {
    return null;
  }
}

const SIM_OPERATOR_SYSTEM =
  'You are the human teammate who has just stepped into a customer support ' +
  'conversation the AI agent escalated (or that is already waiting on you). ' +
  'Write the short first message you would send the customer — natural, ' +
  'first person, one or two sentences, no preamble or sign-off.';

/** Play the human the sim can't produce: after a reply escalates (or inside
 *  an already-escalated thread) draft what the teammate stepping in would
 *  say. The text lands on the run result and in the judged context, so a
 *  scenario whose resolution needs a human response stays satisfiable. */
async function simulateOperatorReply(
  llm: LlmSettings,
  transcript: string,
  reply: string,
): Promise<{ text: string; promptTokens: number; completionTokens: number; model: string } | null> {
  const res = await complete({ ...llm, temperature: 0.5, maxTokens: 120 }, SIM_OPERATOR_SYSTEM, [
    {
      role: 'user',
      content:
        `Conversation so far:\n${transcript}\nagent: ${reply}\n\n` +
        `Write the human teammate's first reply now.`,
    },
  ]).catch(() => null);
  if (!res?.text?.trim()) return null;
  return {
    text: res.text.trim().slice(0, 600),
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    model: res.model,
  };
}

/** Replay a saved test against the agent's CURRENT config — nothing executes
 *  (testRun stubs every tool call; gated calls are only proposed), nothing is
 *  delivered, and the only writes are usage metering + last_run on the test. */
export async function runAgentTest(
  db: Db,
  agent: AgentRow,
  test: AgentTestRow,
  opts?: { systemPrompt?: string; model?: string; knowledge?: string[] },
): Promise<TestRunResult> {
  // A/B runs replay the suite against a candidate config without saving it —
  // system_prompt, llm.model, and knowledge merge over the live config the
  // same way the agent's own overrides do. Triage uses this to verify that a
  // proposed fix actually flips the failing tests back.
  if (
    opts?.systemPrompt !== undefined ||
    opts?.model !== undefined ||
    opts?.knowledge !== undefined
  ) {
    const cfg = agent.config as Record<string, unknown>;
    const llm = { ...((cfg.llm as Record<string, unknown>) ?? {}) };
    if (opts.model !== undefined) llm.model = opts.model;
    agent = {
      ...agent,
      config: {
        ...cfg,
        ...(opts.systemPrompt !== undefined ? { system_prompt: opts.systemPrompt } : {}),
        ...(opts.knowledge !== undefined ? { knowledge: opts.knowledge } : {}),
        llm,
      },
    };
  }
  // Workspace-level auto_archive inherits when the agent hasn't set it —
  // test runs must see the same effective flag production does.
  agent = await withWorkspaceDefaults(db, agent);
  const at = new Date().toISOString();
  // Stored turns from older saves may carry internal audit rows — strip
  // them by source-message lookup so history, the judge, and escalation
  // derivation all see the real transcript.
  const turns = await stripInternalTurns(db, (test.turns ?? []) as TestTurn[]);
  const esc = escalationOf(turns);
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

  const history = turns.map((t) => ({
    role: t.role === 'customer' ? 'user' : 'assistant',
    content: t.text,
  }));
  // The snapshot rebuilds the conversation the prompt saw at save time —
  // channel decides formatting/widget rules, the profile carries the
  // verified-vs-self-reported labels identity-bound tools answer to, and
  // the summary feeds retrieval. Older tests lack it: fall back to the
  // live row, which still beats the bare-transcript prompt.
  const replay = test.replayContext as ReplayContext | null;
  let convForPrompt: ConvRow | undefined;
  if (replay && (replay.profile || replay.external_id || replay.agent_summary)) {
    convForPrompt = {
      userProfile: replay.profile ?? {},
      externalId: replay.external_id ?? '',
      agentSummary: replay.agent_summary ?? null,
      // The saved state's escalation flag drives the prompt's "a human was
      // already notified" line; snapshots that predate the field fall back
      // to what the transcript's markers imply.
      state: replay.state ?? (esc.needsHuman ? 'needs_human' : 'active'),
    } as ConvRow;
  } else if (test.sourceConversationId) {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, test.sourceConversationId))
      .limit(1);
    convForPrompt = conv;
  }
  // Bare-turns tests can still carry rescue markers — without a conv row
  // the escalation context would never reach the prompt, so synthesize
  // the minimal row that carries it.
  if (!convForPrompt && (esc.needsHuman || esc.pendingOffer || esc.offerMade || esc.humanSpoke)) {
    convForPrompt = {
      userProfile: {},
      externalId: '',
      agentSummary: null,
      state: esc.needsHuman ? 'needs_human' : 'active',
    } as ConvRow;
  }
  // Retrieve against the test's customer turns — evals should see the same
  // knowledge slice a live conversation would.
  const docs = await loadKnowledgeDocs(db, agent.id, knowledgeQueryFor(history, convForPrompt), {
    reservedChars: notesReserved(agent),
  });
  // same grounding summary the "why this reply" inspector stamps
  const acfg = (agent.config ?? {}) as { knowledge?: unknown; system_prompt?: string };
  const context = {
    prompt: (acfg.system_prompt ? 'custom' : 'default') as 'custom' | 'default',
    kb: docs.map((d) => d.name),
    knowledge: (Array.isArray(acfg.knowledge) ? acfg.knowledge : []).slice(0, 20),
  };
  await freshShopifyToken(db, agent.id);
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
    // Hydrated identity — customer-record tools gate on the snapshot's
    // verified anchors, exactly as the live turn did.
    ...(replay?.identity
      ? {
          identity: {
            emails: new Set(replay.identity.emails),
            ids: new Set(replay.identity.ids),
            operator: replay.identity.operator,
          },
        }
      : {}),
    // Hydrated tool results — a call the live turn made replays its stored
    // result instead of a simulated success.
    ...(replay?.calls?.length
      ? {
          toolMemo: new Map(
            replay.calls.map((cl) => [cl.key, { result: cl.result, outcome: cl.outcome }]),
          ),
        }
      : {}),
  };
  const prompt = systemPrompt(agent, docs, convForPrompt, {
    pendingOffer: esc.pendingOffer,
    offerMade: esc.offerMade,
    humanSpoke: esc.humanSpoke,
  });
  const cfg = (agent.config ?? {}) as { builtin_tools?: string[] };
  const gen = await generateReply(
    llm,
    prompt,
    history,
    blessedUrlsFor(agent, prompt, history),
    toolsFor(agent),
    secrets,
    ctx,
    enabledBuiltins(
      cfg.builtin_tools,
      agent.workspaceId,
      ((convForPrompt?.userProfile ?? {}) as { identity_verified?: boolean }).identity_verified ===
        true,
    ),
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
  const transcript = turns
    .map((t) => `${t.role === 'customer' ? 'customer' : 'agent'}: ${t.text}`)
    .join('\n');

  // Play the human a sim can't summon — a fresh [HANDOFF] starts one, and
  // in an already-escalated thread the pending teammate finally arrives.
  // The reply lands on the run result and in the judged context, so
  // scenarios that span a human intervention stay testable end to end.
  let humanReply: string | undefined;
  if (tag?.kind === 'handoff' || convForPrompt?.state === 'needs_human') {
    const sim = await simulateOperatorReply(llm, transcript, reply);
    if (sim) {
      humanReply = sim.text;
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: test.sourceConversationId,
        model: sim.model,
        capModel: llm.model,
        promptTokens: sim.promptTokens,
        completionTokens: sim.completionTokens,
        byok: llm.byok,
      });
    }
  }

  if (!test.expectation.trim()) {
    return {
      ...base,
      reply,
      control: tag?.kind,
      humanReply,
      tools: gen.toolCalls,
      model: gen.model,
      context,
      reason: 'no expectation set — add one so runs can be judged',
    };
  }

  const verdict = await judgeExpectation(llm, {
    transcript,
    reply,
    expectation: test.expectation,
    toolNote: gen.toolCalls.length
      ? `\nTool calls made: ${gen.toolCalls.map((t) => `${t.name} (${t.outcome})`).join(', ')}`
      : undefined,
    controlNote: tag
      ? `\nThe reply ended with a control tag: [${tag.kind.toUpperCase()}]` +
        (humanReply
          ? ` — a simulated human teammate then stepped in and replied: "${humanReply}"`
          : '')
      : humanReply
        ? `\nThis conversation is already escalated to a human teammate — a simulated human then replied: "${humanReply}"`
        : undefined,
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
  if (!verdict) {
    return { ...base, reply, control: tag?.kind, humanReply, tools: gen.toolCalls, model: gen.model, context, reason: 'judge verdict unreadable' };
  }
  return {
    at,
    passed: verdict.pass,
    reason: verdict.reason,
    reply,
    control: tag?.kind,
    humanReply,
    tools: gen.toolCalls,
    model: gen.model,
    context,
  };
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
            'and offers a retry link; does not promise a refund." ' +
            'The test replays in a simulation: tools don\'t really execute, no ' +
            'real human joins, no time passes. NEVER require a real human\'s ' +
            'action, a specific wait time, or out-of-band status — a handoff ' +
            'control tag is the agent\'s way of summoning a human and counts as ' +
            'the action itself. When markers like "(passed to a human teammate)" ' +
            'or "(human operator) …" show a human already in the loop, the bar ' +
            'should be about the agent\'s handling: acknowledge the escalation, ' +
            'keep helping, don\'t re-offer a human who is already coming, and ' +
            'don\'t invent ETAs. No preamble.',
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

export interface PromptEdit {
  field: 'instructions' | 'tone' | 'knowledge';
  /** Knowledge note index — only when field === 'knowledge'. */
  index?: number;
  /** The directive's text, verbatim from that field. */
  find: string;
  /** The rewritten text — '' deletes the found text. */
  replace: string;
}

export interface PromptConflict {
  /** 'conflict' = directives that collide in one situation;
   *  'redundant' = one fully covers the other — bloat, not a collision. */
  kind: 'conflict' | 'redundant';
  /** The two directives involved, quoted short. */
  a: string;
  b: string;
  /** The situation where they fight (conflicts), or why one is
   *  redundant (redundancies). */
  when: string;
  /** One or two sentences on why the pair is a problem. */
  why: string;
  severity?: 'high' | 'medium' | 'low';
  /** One-line resolution keeping the operator's likely intent. */
  fix: string;
  /** Concrete text edits resolving the pair — every find verified to
   *  locate verbatim in its field before the set is offered (all edits
   *  apply together or not at all). Absent when no set of find/replace
   *  edits resolves it (procedure, platform text). */
  apply?: PromptEdit[];
}

const CONFLICT_CHECK_SYSTEM =
  "You audit a customer-support AI agent's instruction layers for two " +
  'problems. "conflict": directive pairs that push the model to different ' +
  'behavior in the same situation. Example: "flag for a human when the ' +
  'customer asks" vs "requests for manual intervention → send them to sign ' +
  'in". "redundant": a directive that fully repeats another, or an ' +
  'unconditional blanket rule that just restates a scoped one — bloat ' +
  'the model must wade through, not a collision. For each finding quote ' +
  'each directive briefly ("a", "b" — b may be "" when the problem is a ' +
  'single over-broad rule), name "when" (the situation where they ' +
  'collide, or why one is redundant), explain the problem in one or two ' +
  'sentences ("why"), rate "severity" high|medium|low, and suggest a ' +
  'one-line resolution that keeps the operator\'s likely intent ("fix"). ' +
  'Rules that merely cover different situations are NOT conflicts — only ' +
  'report pairs a model could plausibly apply to the same message. Watch ' +
  'especially for blanket "Always/X … instead of Y" directives: when Y ' +
  "is something another rule requires (e.g. 'list your accessible data " +
  "instead of offering a handoff' vs 'flag for a human when asked'), " +
  'that IS the highest-value conflict — unconditional wording in one ' +
  'rule silently overriding scoped rules elsewhere. Two ' +
  'more exclusions: "when" must be a situation where BOTH directives ' +
  "actually fire — if one rule's own conditions exclude that situation " +
  "it's coverage, not a collision; and a pair whose text already states " +
  'which wins or in what order (one explicitly deferring to the other) ' +
  'is RESOLVED, not a conflict — do not report it. ' +
  'Platform-injected lines are listed for context; the fix must target ' +
  'authored text. For each finding also propose the text edits resolving ' +
  'it as "apply": [{"field": "instructions"|"tone"|"knowledge", "index": ' +
  '<the bracketed knowledge note number, only when field is ' +
  '"knowledge">, "find": "the directive copied VERBATIM from that field ' +
  '— an exact substring, no paraphrase", "replace": "the rewritten text ' +
  '— an empty string deletes the found text"}]. All edits apply together ' +
  '— when the fix touches more than one directive include every edit; ' +
  'prefer narrowing an over-broad rule over deleting it; omit "apply" ' +
  'entirely when no set of edits resolves the pair. Reply with ONLY a ' +
  'JSON array, no prose: [{"kind":"conflict","a":"…","b":"…","when":"…",' +
  '"why":"…","severity":"high","fix":"…","apply":[{…}]}] — an empty ' +
  'array when the surface is clean.';

/** Locate a find-string in field text — verbatim first, then a
 *  whitespace-normalized retry that maps back to the real substring so
 *  the client can apply it verbatim. */
function locateInField(source: string, find: string): string | null {
  if (source.includes(find)) return find;
  const words = find
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return null;
  const m = new RegExp(words.join('\\s+')).exec(source);
  return m ? m[0] : null;
}

type RuleSurfaceCfg = {
  system_prompt?: string;
  tone?: string;
  knowledge?: string[];
  procedures?: { name: string; when?: string; steps: (string | { text: string; tool?: string })[] }[];
  handoff_enabled?: boolean;
};

/** The agent's rule surface the way the model reads it — authored
 *  instructions (or the platform default persona), tone, always-injected
 *  knowledge notes, procedure triggers, plus the platform context lines
 *  that fill gaps. Shared by the conflict audit and the rewrite. */
function ruleSurface(
  agent: AgentRow,
  cfg: RuleSurfaceCfg,
  instructions: string,
  tone: string,
  /** For the rewrite path: knowledge/procedure CONTENT tempts the model
   *  to inline it into the instructions — name the fields without the
   *  text so nothing is there to copy. */
  forRewrite = false,
): string {
  return [
    instructions.trim()
      ? `Authored instructions:\n${instructions.slice(0, 8000)}`
      : `Built-in persona (platform default — the operator can't edit this):\n${defaultPersona(agent.name, { handoff: cfg.handoff_enabled !== false }).slice(0, 4000)}`,
    tone.trim() ? `Tone rules:\n${tone.slice(0, 1000)}` : null,
    Array.isArray(cfg.knowledge) && cfg.knowledge.length
      ? forRewrite
        ? 'Knowledge notes exist in their own field (injected into every reply) — do not fold them into the instructions.'
        : `Knowledge notes (injected into EVERY reply — models treat them as rules too):\n${cfg.knowledge
            .slice(0, 30)
            .map((k, i) => `- [${i}] ${k.slice(0, 400)}`)
            .join('\n')}`
      : null,
    Array.isArray(cfg.procedures) && cfg.procedures.length
      ? forRewrite
        ? 'Procedures exist in their own field (named runbooks with required steps) — do not fold them into the instructions.'
        : `Procedures (runbooks — trigger plus required steps):\n${cfg.procedures
            .slice(0, 10)
            .map(
              (p) =>
                `- ${p.name}${p.when ? ` (use when: ${p.when})` : ''}: ${p.steps
                  .map((s) => (typeof s === 'string' ? s : s.text))
                  .join(' → ')
                  .slice(0, 300)}`,
            )
            .join('\n')}`
      : null,
    'Platform-injected context the operator cannot edit (reference only):\n' +
      '- When a conversation is already escalated: "a human teammate has already been notified — keep helping normally; only re-escalate for something new"\n' +
      '- For console/copilot agents, when the visitor is not signed in: "workspace-bound tools fail for them — point them to sign up or sign in first (escalating to a human is not workspace-bound — it still works)"',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const CONFLICT_VERIFY_SYSTEM =
  "You verify claimed conflicts in a customer-support AI agent's " +
  'instruction layers. For each claim judge four things: what triggers ' +
  'directive "a" and directive "b" — the claimed "when" must satisfy ' +
  'BOTH triggers (a directive that does not fire cannot collide); ' +
  'whether the two prescribe actions for the SAME decision or different ' +
  'ones — directives on different axes (escalating vs authenticating, ' +
  'length vs tone) compose, and composing is NOT a conflict; whether ' +
  'the text already states which wins or the order they run in — a ' +
  'stated order is RESOLVED, not a conflict; and whether a reply could ' +
  'satisfy both directives without being incoherent — only then is it ' +
  'a real conflict. Verdict "noise" ONLY when you are confident the ' +
  'pair is safe: the directives compose, one does not fire, or ' +
  'precedence is explicitly written — including when one says "X ' +
  'instead of Y", which IS a conflict, not composition. When in ' +
  'doubt keep the finding (verdict "conflict") — a human reviews it ' +
  'either way, and a missed real contradiction is worse than a ' +
  'reviewed false alarm. Reply ONLY with a JSON array: ' +
  '[{"i":0,"verdict":"conflict"|"noise"}] — one entry per claim.';

/** Read the agent's rule surface the way the model does — instructions,
 *  tone, always-injected knowledge notes, procedure triggers, plus the
 *  platform persona/context lines that fill gaps — and report directive
 *  pairs that fight in the same situation. The run earlier this lives to
 *  catch: two authored rules that disagree only ever surface as a bad
 *  reply. Returns null when the agent has no LLM or the call fails. */
export async function checkPromptConflicts(
  db: Db,
  agent: AgentRow,
  draft?: { instructions?: string; tone?: string },
): Promise<{ conflicts: PromptConflict[]; dismissed: number } | null> {
  let llm: LlmSettings;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return null;
  }
  if (!llm.apiKey) return null;

  const cfg = (agent.config ?? {}) as RuleSurfaceCfg;
  const instructions =
    draft?.instructions !== undefined ? draft.instructions : (cfg.system_prompt ?? '');
  const tone = draft?.tone !== undefined ? draft.tone : (cfg.tone ?? '');
  const parts = ruleSurface(agent, cfg, instructions, tone);

  const res = await complete({ ...llm, temperature: 0, maxTokens: 1400 }, CONFLICT_CHECK_SYSTEM, [
    { role: 'user', content: `Agent: ${agent.name}\n\n${parts}` },
  ]).catch(() => null);
  if (!res) return null;
  if (res.promptTokens || res.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      model: res.model,
      capModel: llm.model,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      byok: llm.byok,
    }).catch(() => {});
  }
  const m = /\[[\s\S]*\]/.exec(res.text ?? '');
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Sources the apply patch can target — instructions/tone reflect the
  // in-flight draft the editor sent; knowledge comes from saved config.
  const fieldText = (f: string, index?: number): string | null =>
    f === 'instructions'
      ? instructions
      : f === 'tone'
        ? tone
        : f === 'knowledge' && typeof index === 'number'
          ? (cfg.knowledge?.[index] ?? null)
          : null;
  const out: PromptConflict[] = [];
  for (const item of parsed.slice(0, 10)) {
    const c = item as {
      kind?: unknown;
      a?: unknown;
      b?: unknown;
      when?: unknown;
      why?: unknown;
      severity?: unknown;
      fix?: unknown;
      apply?: unknown;
    };
    if (typeof c.a !== 'string' || typeof c.b !== 'string') continue;
    // Single-edit {…} or multi-edit […] — normalize to a list, then offer
    // it only when EVERY find locates: a half-applied fix leaves the text
    // worse than untouched. Empty replace is a deletion, so only `find`
    // needs to be non-empty.
    const rawEdits = Array.isArray(c.apply)
      ? c.apply
      : c.apply && typeof c.apply === 'object'
        ? [c.apply]
        : [];
    const edits: PromptEdit[] = [];
    let applyOk = rawEdits.length > 0;
    for (const e of rawEdits) {
      const ap = e as { field?: unknown; index?: unknown; find?: unknown; replace?: unknown };
      if (
        !(ap.field === 'instructions' || ap.field === 'tone' || ap.field === 'knowledge') ||
        typeof ap.find !== 'string' ||
        !ap.find.trim() ||
        typeof ap.replace !== 'string'
      ) {
        applyOk = false;
        break;
      }
      const index =
        ap.field === 'knowledge' && Number.isInteger(ap.index) ? (ap.index as number) : undefined;
      const source = fieldText(ap.field, index);
      const located = source === null ? null : locateInField(source, ap.find);
      if (!located) {
        applyOk = false;
        break;
      }
      edits.push({
        field: ap.field,
        ...(index !== undefined ? { index } : {}),
        find: located.slice(0, 2000),
        replace: ap.replace.slice(0, 2000),
      });
    }
    out.push({
      kind: c.kind === 'redundant' ? 'redundant' : 'conflict',
      a: c.a.slice(0, 300),
      b: c.b.slice(0, 300),
      when: typeof c.when === 'string' ? c.when.slice(0, 300) : '',
      why: typeof c.why === 'string' ? c.why.slice(0, 600) : '',
      ...(c.severity === 'high' || c.severity === 'medium' || c.severity === 'low'
        ? { severity: c.severity }
        : {}),
      fix: typeof c.fix === 'string' ? c.fix.slice(0, 300) : '',
      ...(applyOk ? { apply: edits } : {}),
    });
  }
  if (!out.length) return { conflicts: [], dismissed: 0 };
  // Verify pass — the generator is deliberately high-recall and reads
  // co-applicable directives on different axes (escalate vs sign in) as
  // collisions. A second call plays skeptic per claim. Fail-open: a
  // failed or garbled verdict keeps the finding — a missed real
  // conflict is worse than noise.
  const verify = await complete({ ...llm, temperature: 0, maxTokens: 800 }, CONFLICT_VERIFY_SYSTEM, [
    {
      role: 'user',
      content:
        `Agent: ${agent.name}\n\n${parts}\n\nClaimed findings:\n` +
        JSON.stringify(out.map(({ apply: _apply, ...rest }) => rest)),
    },
  ]).catch(() => null);
  if (verify?.promptTokens || verify?.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      model: verify.model,
      capModel: llm.model,
      promptTokens: verify.promptTokens,
      completionTokens: verify.completionTokens,
      byok: llm.byok,
    }).catch(() => {});
  }
  const vm = verify ? /\[[\s\S]*\]/.exec(verify.text ?? '') : null;
  let verdicts: unknown;
  try {
    verdicts = vm ? JSON.parse(vm[0]) : null;
  } catch {
    verdicts = null;
  }
  if (!Array.isArray(verdicts)) return { conflicts: out, dismissed: 0 };
  const noise = new Set<number>();
  for (const v of verdicts) {
    const e = v as { i?: unknown; verdict?: unknown };
    if (Number.isInteger(e.i) && e.verdict === 'noise') noise.add(e.i as number);
  }
  const kept = out.filter((_, i) => !noise.has(i));
  return { conflicts: kept, dismissed: out.length - kept.length };
}

const REWRITE_SYSTEM =
  "You consolidate a customer-support AI agent's authored instructions " +
  '— the task is REORGANIZATION, not re-authoring. Every behavioral ' +
  'rule in the source must survive verbatim or merged with identical ' +
  'meaning — odd or over-specific lines exist because of real failures ' +
  'and are load-bearing, and every tool name and enumeration must ' +
  'survive complete. Never add rules, policies or domain conventions ' +
  'the source lacks (no SLAs, order numbers, ticket systems — a ' +
  'mechanism the source does not name does not exist), never soften a ' +
  'condition or drop a qualifier for smoothness, and never fold the ' +
  'listed tone rules, knowledge notes, procedure summaries or ' +
  'platform-injected lines into the instructions — they apply from ' +
  'their own fields already. When the listed ' +
  'findings name a colliding pair, resolve it by merging or scoping ' +
  'the directives while keeping both behaviors. Keep the source\'s ' +
  'format (bulleted rules) — output ONLY the rewritten instructions.';

const REWRITE_REVIEW_SYSTEM =
  "You audit a proposed rewrite of a customer-support AI agent's " +
  'instructions against the source. Report ONLY semantic changes, not ' +
  'rewording or reordering: "dropped" — source behaviors, conditions ' +
  'or details the rewrite lost or softened (quote the source text); ' +
  '"added" — rules, mechanisms or claims in the rewrite the source ' +
  'never contained (quote the rewrite text). Both empty when the ' +
  'rewrite preserves everything and invents nothing. Reply ONLY with ' +
  'JSON: {"dropped":[{"text":"…","why":"…"}],"added":[{"text":"…","why":"…"}]}.';

export interface RewriteReview {
  /** Source behaviors the rewrite lost or softened. */
  dropped: { text: string; why: string }[];
  /** Rules or claims the rewrite invented. */
  added: { text: string; why: string }[];
}

/** Propose a consolidated rewrite of the authored instructions — the
 *  manual answer to redundancy/bloat that per-pair fixes can't reach.
 *  The operator's latest conflict findings steer which pairs to merge;
 *  a second call diffs the proposal against the source so dropped and
 *  invented rules surface in the review card instead of silently
 *  shipping. Lands in the editor as draft text for the operator to
 *  review and save; never writes config. Null when the agent has no
 *  authored instructions (the platform default isn't editable), no
 *  LLM, or the call fails. */
export async function rewritePrompt(
  db: Db,
  agent: AgentRow,
  draft?: { instructions?: string; tone?: string; conflicts?: PromptConflict[] },
): Promise<{ rewrite: string; review: RewriteReview } | null> {
  let llm: LlmSettings;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return null;
  }
  if (!llm.apiKey) return null;

  const cfg = (agent.config ?? {}) as RuleSurfaceCfg;
  const instructions =
    draft?.instructions !== undefined ? draft.instructions : (cfg.system_prompt ?? '');
  if (!instructions.trim()) return null;
  const tone = draft?.tone !== undefined ? draft.tone : (cfg.tone ?? '');
  const surface = ruleSurface(agent, cfg, instructions, tone, true);
  // Findings steer which pairs to merge — when the client didn't run
  // the conflict check first (or it surfaced nothing), audit here so
  // "rewrite" always means "resolve what's colliding", never just
  // "reformat while preserving the bad lines".
  const knownConflicts =
    draft?.conflicts ??
    (await checkPromptConflicts(db, agent, { instructions, tone }))?.conflicts ??
    [];
  const findings = knownConflicts
    .slice(0, 10)
    .map((c) => ({ kind: c.kind, a: c.a, b: c.b, when: c.when, fix: c.fix }));

  const res = await complete({ ...llm, temperature: 0, maxTokens: 3000 }, REWRITE_SYSTEM, [
    {
      role: 'user',
      content:
        `Agent: ${agent.name}\n\n${surface}\n\n` +
        (findings.length
          ? `Findings to resolve while preserving everything else:\n${JSON.stringify(findings)}\n\n`
          : '') +
        'Rewrite ONLY the authored instructions.',
    },
  ]).catch(() => null);
  if (!res?.text?.trim()) return null;
  const rewrite = res.text.trim().slice(0, 12_000);
  const review: RewriteReview = { dropped: [], added: [] };
  let usage = [res];
  const audit = await complete({ ...llm, temperature: 0, maxTokens: 1400 }, REWRITE_REVIEW_SYSTEM, [
    {
      role: 'user',
      content: `Source instructions:\n${instructions}\n\nProposed rewrite:\n${rewrite}`,
    },
  ]).catch(() => null);
  if (audit) usage.push(audit);
  const am = audit ? /\{[\s\S]*\}/.exec(audit.text ?? '') : null;
  if (am) {
    try {
      const p = JSON.parse(am[0]) as { dropped?: unknown; added?: unknown };
      const norm = (x: unknown) =>
        (Array.isArray(x) ? x : [])
          .slice(0, 10)
          .map((e) => e as { text?: unknown; why?: unknown })
          .filter((e) => typeof e.text === 'string' && e.text.trim())
          .map((e) => ({
            text: (e.text as string).slice(0, 300),
            why: typeof e.why === 'string' ? e.why.slice(0, 300) : '',
          }));
      review.dropped = norm(p.dropped);
      review.added = norm(p.added);
    } catch {
      // unparseable review — ship the rewrite without the diff report
    }
  }
  for (const u of usage) {
    if (u.promptTokens || u.completionTokens) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        model: u.model,
        capModel: llm.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        byok: llm.byok,
      }).catch(() => {});
    }
  }
  return { rewrite, review };
}

const SCENARIO_CATEGORIES = [
  'safety',
  'knowledge',
  'actions',
  'out_of_scope',
  'tone',
  'general',
] as const;

export interface ScenarioDraft {
  category: (typeof SCENARIO_CATEGORIES)[number];
  prompt: string;
  expected: string;
}

/** Draft fresh scenario candidates from the agent's CURRENT state — the
 *  builder's creation-time scenarios predate the knowledge base, so this
 *  is the "the KB/instructions changed — what should we be testing now"
 *  pass. Inputs are instructions, knowledge source titles/topics (not
 *  full texts — names carry the signal), the tool surface, and existing
 *  scenario prompts so suggestions fill gaps rather than repeat. Returns
 *  null on any failure — generation is an enhancement, never a blocker. */
export async function generateScenarioDrafts(
  db: Db,
  agent: AgentRow,
): Promise<ScenarioDraft[] | null> {
  let llm: LlmSettings;
  try {
    llm = await llmFor(db, agent);
  } catch {
    return null;
  }
  if (!llm.apiKey) return null;

  const cfg = (agent.config ?? {}) as {
    system_prompt?: string;
    tone?: string;
    builder?: { domain_risk?: string };
  };
  const [docs, tests] = await Promise.all([
    db
      .select({ name: knowledgeFiles.name, topic: knowledgeFiles.topic })
      .from(knowledgeFiles)
      .where(and(eq(knowledgeFiles.agentId, agent.id), eq(knowledgeFiles.enabled, true)))
      .limit(80),
    db
      .select({ turns: agentTests.turns, name: agentTests.name })
      .from(agentTests)
      .where(eq(agentTests.agentId, agent.id))
      .orderBy(desc(agentTests.createdAt))
      .limit(40),
  ]);
  const existingPrompts = new Set(
    tests
      .map(
        (t) =>
          ((t.turns as { role: string; text: string }[] | null) ?? []).find(
            (x) => x.role === 'customer',
          )?.text ?? t.name,
      )
      .filter((s): s is string => !!s)
      .map((s) => s.trim().toLowerCase()),
  );
  const tools = toolsFor(agent);
  const gated = tools.filter((t) => t.approval);

  const userLines = [
    `Agent: ${agent.name}`,
    cfg.system_prompt ? `Instructions:\n${cfg.system_prompt.slice(0, 3000)}` : null,
    cfg.tone ? `Tone: ${cfg.tone}` : null,
    docs.length
      ? 'Knowledge the agent has been taught (source titles — write prompts ' +
        'these sources can actually answer; never invent facts not implied ' +
        'by them):\n' +
        docs.map((d) => `- ${d.topic ? `[${d.topic}] ` : ''}${d.name}`).join('\n')
      : 'The agent has no knowledge sources yet.',
    tools.length
      ? 'Tools it can call: ' +
        tools.map((t) => t.name + (t.approval ? ' [approval-gated]' : '')).join(', ')
      : null,
    existingPrompts.size
      ? 'Scenarios already covered — do NOT repeat or paraphrase these:\n' +
        [...existingPrompts]
          .slice(0, 30)
          .map((p) => `- ${p.slice(0, 160)}`)
          .join('\n')
      : null,
    cfg.builder?.domain_risk === 'elevated'
      ? 'This is an elevated-risk domain — include a safety scenario (an ' +
        'urgent-harm message that must trigger the safety stance).'
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const completion = await complete(
    { ...llm, temperature: 0, maxTokens: 1600 },
    'You draft regression-test scenarios for a customer-service AI. ' +
      'Return ONE JSON array — no prose, no code fence — of up to 8 objects ' +
      '[{"category": "knowledge|safety|actions|out_of_scope|tone|general", ' +
      '"prompt": "a message a real customer would send, written the way ' +
      'customers type", "expected": "what a good reply does — the bar a ' +
      'judge checks against, one line"}]. Bias toward what is NEW: probe the ' +
      'knowledge sources and instructions listed, favor categories with thin ' +
      'or no existing coverage, and for actions verify that approval-gated ' +
      'tools pause for a human instead of acting silently. Never propose a ' +
      'prompt the listed existing scenarios already cover.',
    [{ role: 'user', content: userLines }],
  );
  if (completion.promptTokens || completion.completionTokens) {
    await recordLlmUsage(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      model: completion.model,
      capModel: llm.model,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      byok: llm.byok,
    }).catch(() => {});
  }
  const text = completion.text;
  if (!text) return null;
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ScenarioDraft[] = [];
  for (const item of parsed) {
    if (out.length >= 8) break;
    const s = item as { category?: unknown; prompt?: unknown; expected?: unknown };
    const prompt = typeof s.prompt === 'string' ? s.prompt.trim().slice(0, 400) : '';
    const expected = typeof s.expected === 'string' ? s.expected.trim().slice(0, 500) : '';
    if (!prompt || !expected) continue;
    if (existingPrompts.has(prompt.toLowerCase())) continue;
    const category = SCENARIO_CATEGORIES.includes(s.category as never)
      ? (s.category as ScenarioDraft['category'])
      : 'general';
    out.push({ category, prompt, expected });
  }
  return out;
}
