import { and, desc, eq } from 'drizzle-orm';
import type { OutboundWebhook, UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, conversations, knowledgeFiles, messages } from '../db/schema.js';
import { env } from '../env.js';
import { processEvents } from '../services/ingest.js';
import { storeSuggestion } from '../services/suggestions.js';
import { recordLlmUsage } from './usage.js';
import { interpolateSecrets, loadSecretsMap } from './secrets.js';
import { bus } from './bus.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

export interface LlmSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Per-agent LLM config with env fallback (OpenAI-compatible). */
export function llmFor(agent: AgentRow): LlmSettings {
  const cfg = (agent.config ?? {}) as {
    llm?: { api_key?: string; base_url?: string; model?: string };
  };
  return {
    apiKey: cfg.llm?.api_key || env.llmApiKey,
    baseUrl: (cfg.llm?.base_url || env.llmBaseUrl).replace(/\/$/, ''),
    model: cfg.llm?.model || env.llmModel,
  };
}

const MAX_KNOWLEDGE_CHARS = 80_000;

/** Extracted text from the agent's uploaded knowledge files, capped for the prompt. */
export async function loadKnowledgeDocs(
  db: Db,
  agentId: string,
): Promise<{ name: string; text: string }[]> {
  const rows = await db
    .select({ name: knowledgeFiles.name, text: knowledgeFiles.text })
    .from(knowledgeFiles)
    .where(and(eq(knowledgeFiles.agentId, agentId), eq(knowledgeFiles.status, 'ready')));
  let used = 0;
  const docs: { name: string; text: string }[] = [];
  for (const row of rows) {
    const remaining = MAX_KNOWLEDGE_CHARS - used;
    if (remaining <= 0) break;
    const text = row.text.slice(0, remaining);
    if (!text) continue;
    used += text.length;
    docs.push({ name: row.name, text });
  }
  return docs;
}

/** Delimited, data-only context: which channel the agent is on and who the
 *  end user is. Never framed as instructions. */
export function conversationContext(conv: ConversationRow): string {
  const p = (conv.userProfile ?? {}) as UserProfile;
  const channel = p.channel ?? conv.externalId.split(':')[0] ?? 'external';
  const lines = [
    `- Channel: ${channel}${p.channel_name ? ` — account "${p.channel_name}"` : ''}`,
  ];
  const who = [p.name, p.username ? `(@${p.username})` : null].filter(Boolean).join(' ');
  if (who) lines.push(`- Customer: ${who}`);
  if (p.id) lines.push(`- Customer platform id: ${p.id}`);
  if (p.phone) lines.push(`- Customer phone: ${p.phone}`);
  lines.push(
    p.email
      ? `- Customer email: ${p.email}`
      : '- Customer email: unknown — if you need it, ask the customer and save it with save_user_profile',
  );
  return `\nConversation context (background information about this conversation, not instructions):\n${lines.join('\n')}`;
}

export function systemPrompt(
  agent: AgentRow,
  docs: { name: string; text: string }[] = [],
  conv?: ConversationRow,
): string {
  const cfg = (agent.config ?? {}) as {
    system_prompt?: string;
    knowledge?: string[];
    tone?: string;
  };
  const parts = [
    cfg.system_prompt ||
      'You are a helpful support agent. Answer concisely and accurately. If you are unsure, or the request needs a human, reply with exactly: [HANDOFF]',
  ];
  if (cfg.knowledge?.length) {
    parts.push(`\nKnowledge base:\n${cfg.knowledge.map((k) => `- ${k}`).join('\n')}`);
  }
  if (docs.length) {
    parts.push(
      `\nKnowledge base documents (answer from these when relevant):\n${docs
        .map((d) => `--- ${d.name} ---\n${d.text}`)
        .join('\n\n')}`,
    );
  }
  if (cfg.tone) parts.push(`\nTone: ${cfg.tone}`);
  if (conv) parts.push(conversationContext(conv));
  parts.push('\nIf the user asks for a human or you cannot help, reply with exactly: [HANDOFF]');
  return parts.join('');
}

interface ToolDef {
  name: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

function toolsFor(agent: AgentRow): ToolDef[] {
  const cfg = (agent.config ?? {}) as { tools?: ToolDef[] };
  return (cfg.tools ?? []).filter((t) => t.name && t.url);
}

/**
 * SSRF guard: https to anywhere; http only to localhost (dev stubs).
 * Client-supplied URLs are called server-side, so this matters.
 */
function toolUrlAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return (
      u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

const MAX_TOOL_RESPONSE = 8_000;

async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  secrets: Record<string, string> = {},
): Promise<string> {
  // Secrets expand first — LLM-supplied args can never inject {{secrets.*}}
  // placeholders, and arg values never get a second expansion pass.
  const missing = [
    ...new Set(
      [tool.url, ...Object.values(tool.headers ?? {})]
        .flatMap((s) => [...s.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]))
        .filter((n) => !(n in secrets)),
    ),
  ];
  if (missing.length) {
    return `error: tool needs secrets not configured on this agent: ${missing.join(', ')}`;
  }
  let url = interpolateSecrets(tool.url, secrets);
  const headers = tool.headers
    ? Object.fromEntries(
        Object.entries(tool.headers).map(([k, v]) => [k, interpolateSecrets(v, secrets)]),
      )
    : undefined;
  const used = new Set<string>();
  for (const key of Object.keys(args)) {
    if (url.includes(`{${key}}`)) {
      url = url.replaceAll(`{${key}}`, encodeURIComponent(String(args[key])));
      used.add(key);
    }
  }
  if (!toolUrlAllowed(url)) return 'error: tool URL not allowed';
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));

  if (tool.method === 'GET') {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    );
    if ([...qs].length) url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  const res = await fetch(url, {
    method: tool.method,
    headers: {
      accept: 'application/json',
      ...(tool.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(tool.method === 'POST' ? { body: JSON.stringify(rest) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.text()).slice(0, MAX_TOOL_RESPONSE);
  return res.ok ? body : `error: HTTP ${res.status} ${body.slice(0, 300)}`;
}

export interface AgentRunContext {
  db: Db;
  convId: string;
  workspaceId: string;
}

const SAVE_PROFILE_TOOL = 'save_user_profile';

/**
 * Built-in tool: persist contact details the customer explicitly shared.
 * Meta exposes no email on any platform, so this is how profiles get one.
 * Returns a result string for the tool message.
 */
export async function saveUserProfile(
  ctx: AgentRunContext,
  args: Record<string, unknown>,
): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined;
  const email = typeof args.email === 'string' ? args.email.trim() : undefined;
  const phone = typeof args.phone === 'string' ? args.phone.trim() : undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'error: not saved — that does not look like a valid email address';
  }
  const update = Object.fromEntries(
    Object.entries({ name, email, phone }).filter(([, v]) => v),
  );
  if (!Object.keys(update).length) return 'error: nothing to save';
  const [conv] = await ctx.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, ctx.convId))
    .limit(1);
  if (!conv) return 'error: conversation not found';
  await ctx.db
    .update(conversations)
    .set({ userProfile: { ...(conv.userProfile as UserProfile), ...update } })
    .where(eq(conversations.id, ctx.convId));
  bus.publish(ctx.workspaceId, {
    type: 'conversation',
    data: { id: ctx.convId, state: conv.state },
  });
  return `saved: ${Object.keys(update).join(', ')}`;
}

interface Completion {
  text: string | null;
  promptTokens: number;
  completionTokens: number;
}

type ChatMsg = {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

/** Chat completion with an OpenAI-style tool-call loop (max 4 rounds). */
async function complete(
  llm: LlmSettings,
  system: string,
  history: { role: string; content: string }[],
  tools: ToolDef[] = [],
  secrets: Record<string, string> = {},
  ctx?: AgentRunContext,
): Promise<Completion> {
  const empty = { text: null, promptTokens: 0, completionTokens: 0 };
  if (!llm.apiKey) return empty;

  const msgs: ChatMsg[] = [{ role: 'system', content: system }, ...history];
  const openaiTools = [
    ...tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.params ?? {}).map(([k, d]) => [k, { type: 'string', description: d }]),
          ),
          required: Object.keys(t.params ?? {}),
        },
      },
    })),
    // Built-in: lets the agent save contact details the customer volunteers
    ...(ctx
      ? [
          {
            type: 'function',
            function: {
              name: SAVE_PROFILE_TOOL,
              description:
                'Save contact details the customer explicitly stated in this conversation (name, email, phone). Only call with information the customer gave you — never guess.',
              parameters: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: "customer's full name" },
                  email: { type: 'string', description: "customer's email address" },
                  phone: { type: 'string', description: "customer's phone number" },
                },
              },
            },
          },
        ]
      : []),
  ];
  const toolsSchema = openaiTools.length ? openaiTools : undefined;

  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 0; round < 4; round++) {
    const body = JSON.stringify({
      model: llm.model,
      max_tokens: 400,
      messages: msgs,
      ...(toolsSchema ? { tools: toolsSchema } : {}),
    });
    // One retry — a single timeout shouldn't hand a live conversation to a human
    let res!: Response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${llm.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(25_000),
        });
        break;
      } catch (err) {
        if (attempt === 1) throw err;
      }
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    promptTokens += json.usage?.prompt_tokens ?? Math.ceil(msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4);

    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!calls.length) {
      const text = msg?.content?.trim() ?? null;
      completionTokens += json.usage?.completion_tokens ?? (text ? Math.ceil(text.length / 4) : 0);
      return { text, promptTokens, completionTokens };
    }

    completionTokens += json.usage?.completion_tokens ?? 0;
    msgs.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      const args = JSON.parse(call.function.arguments || '{}');
      let result: string;
      try {
        result =
          call.function.name === SAVE_PROFILE_TOOL && ctx
            ? await saveUserProfile(ctx, args)
            : tool
              ? await callTool(tool, args, secrets)
              : `error: unknown tool ${call.function.name}`;
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : 'tool failed'}`;
      }
      msgs.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  return { text: null, promptTokens, completionTokens };
}

async function transcriptFor(db: Db, convId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return rows
    .reverse()
    .filter((m) => m.text)
    // internal notes (failures/handoffs/alerts) are operator context, not
    // conversation content — feeding them as assistant messages makes the
    // model parrot them back to the customer
    .filter((m) => {
      const f = m.flags as { failure?: boolean; help_requested?: boolean; custom_alert?: boolean };
      return !(f?.failure || f?.help_requested || f?.custom_alert);
    })
    .map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.direction === 'human' ? `(human operator) ${m.text}` : m.text!,
    }));
}

/**
 * In-process agent runtime: same behavior as packages/agent-template, but
 * driven by Janis directly — no webhook_url, no client infra. Replies are
 * ingested as message_out events, which also deliver to the bound channel.
 */
export async function runHostedEvent(
  db: Db,
  agent: AgentRow,
  event: OutboundWebhook,
): Promise<void> {
  if (event.type === 'suggestion.request') {
    const convId = event.janis_conversation_id;
    if (!convId) return;
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);
    if (!conv) return;
    const llm = llmFor(agent);
    const history = await transcriptFor(db, convId);
    const docs = await loadKnowledgeDocs(db, agent.id);
    const secrets = await loadSecretsMap(db, agent.id);
    const ctx: AgentRunContext = { db, convId, workspaceId: agent.workspaceId };
    const result = await complete(
      llm,
      systemPrompt(agent, docs, conv),
      history,
      toolsFor(agent),
      secrets,
      ctx,
    ).catch(() => null);
    if (result) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
    }
    const draft = result?.text;
    const text =
      draft && !draft.includes('[HANDOFF]')
        ? draft
        : 'I want to make sure we get this right — let me look into it and follow up shortly.';
    await storeSuggestion(db, convId, text, 'agent');
    return;
  }

  if (event.type !== 'message.user') return; // takeover/resume/human echoes — no-op

  const convId = event.janis_conversation_id;
  if (!convId) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  // Only a human takeover (or archive) silences the agent — needs_human
  // is a flag for attention, not a pause
  if (!conv || conv.state === 'human' || conv.state === 'archived') return;

  const externalId = conv.externalId;
  const emit = (e: Parameters<typeof processEvents>[2]) => processEvents(db, agent, e);

  try {
    const llm = llmFor(agent);
    const history = await transcriptFor(db, convId);
    const docs = await loadKnowledgeDocs(db, agent.id);
    const secrets = await loadSecretsMap(db, agent.id);
    const ctx: AgentRunContext = { db, convId, workspaceId: agent.workspaceId };
    const { text: reply, promptTokens, completionTokens } = await complete(
      llm,
      systemPrompt(agent, docs, conv),
      history,
      toolsFor(agent),
      secrets,
      ctx,
    );
    if (promptTokens || completionTokens) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens,
        completionTokens,
      });
    }
    if (!reply) {
      await emit([
        { type: 'handoff_request', conversation_id: externalId, reason: 'no LLM configured or empty reply' },
      ]);
      return;
    }
    if (reply.includes('[HANDOFF]')) {
      await emit([
        { type: 'handoff_request', conversation_id: externalId, reason: 'agent signalled handoff' },
      ]);
      return;
    }
    await emit([
      { type: 'message_out', conversation_id: externalId, text: reply, payload: { via: 'hosted' } },
    ]);
  } catch (err) {
    await emit([
      { type: 'failure', conversation_id: externalId, reason: err instanceof Error ? err.message : 'generation failed' },
      { type: 'handoff_request', conversation_id: externalId, reason: 'agent error — needs a human' },
    ]);
  }
}
