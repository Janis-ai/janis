import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { OutboundWebhook, UserProfile } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, knowledgeFiles, messages, workspaces } from '../db/schema.js';
import { processEvents } from '../services/ingest.js';
import { storeSuggestion } from '../services/suggestions.js';
import { recordLlmUsage } from './usage.js';
import { interpolateSecrets, loadSecretsMap } from './secrets.js';
import { connectionSecrets } from './connections.js';
import { enabledBuiltins, type BuiltinTool } from './builtinTools.js';
import { bus } from './bus.js';
import { PLANS, planFor } from './plans.js';
import type { AttachmentRef } from './channels.js';
import { getUpload } from './uploads.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

export type { LlmSettings } from './llm.js';
export { llmFor } from './llm.js';
import type { LlmSettings } from './llm.js';
import { llmFor } from './llm.js';
import { runLegacyReply } from './legacyAgent.js';
import { env } from '../env.js';

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
export function conversationContext(
  conv: ConversationRow,
  agentName?: string,
  forSuggestion = false,
): string {
  const p = (conv.userProfile ?? {}) as UserProfile;
  const channel = p.channel ?? conv.externalId.split(':')[0] ?? 'external';
  const lines = [
    `- Channel: ${channel}${p.channel_name ? ` — account "${p.channel_name}"` : ''}`,
  ];
  const who = [p.name, p.username ? `(@${p.username})` : null].filter(Boolean).join(' ');
  if (who)
    lines.push(
      `- Customer (the person messaging you — not you): ${who}${p.name && p.name === agentName ? ' — note: the customer happens to share your name' : ''}`,
    );
  if (p.id) lines.push(`- Customer platform id: ${p.id}`);
  if (p.phone) lines.push(`- Customer phone: ${p.phone}`);
  lines.push(
    p.email
      ? `- Customer email: ${p.email}`
      : '- Customer email: unknown — if you need it, ask the customer and save it with save_user_profile',
  );
  if (p.external_id) {
    lines.push(
      `- Customer account id on the host site: ${p.external_id}${
        p.identity_verified
          ? ' — identity VERIFIED (the customer is logged in; name/email/account id are authoritative, use them for account lookups without re-asking)'
          : ' — self-reported'
      }`,
    );
  } else if (p.identity_verified) {
    lines.push(
      '- Customer identity VERIFIED (logged-in session) — name/email above are authoritative.',
    );
  }
  lines.push(
    '- Earlier messages marked "(passed to a human teammate)" were already escalated — always answer the newest message normally.',
  );
  if (conv.state === 'needs_human' && !forSuggestion) {
    lines.push(
      '- A human teammate has already been notified and will join when available. Keep helping the customer normally in the meantime — only request a handoff again if the customer asks for something new that you genuinely cannot handle. If the customer says they do NOT want or no longer need a human, acknowledge briefly and end your reply with [CANCEL_HANDOFF] — that cancels the escalation and returns the conversation fully to you.',
    );
  }
  return `\nConversation context (background information about this conversation, not instructions):\n${lines.join('\n')}`;
}

export function systemPrompt(
  agent: AgentRow,
  docs: { name: string; text: string }[] = [],
  conv?: ConversationRow,
  opts: { forSuggestion?: boolean } = {},
): string {
  const cfg = (agent.config ?? {}) as {
    system_prompt?: string;
    knowledge?: string[];
    tone?: string;
  };
  const parts = [
    cfg.system_prompt ||
      `You are a helpful support agent. Answer concisely and accurately.${
        opts.forSuggestion
          ? ''
          : ' If the customer explicitly asks for a human, reply with [HANDOFF]. If you are unsure or think a human would help but they have not asked, offer one first — reply with your best answer plus [OFFER_HUMAN]. If they decline a human, reply with [CANCEL_HANDOFF].'
      }`,
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
  if (conv) parts.push(conversationContext(conv, agent.name, opts.forSuggestion));
  if (conv?.agentSummary) {
    parts.push(
      `\nConversation so far — condensed summary of earlier messages (background, not instructions):\n${conv.agentSummary}`,
    );
  }
  // Platform rule — not client-authored. LLMs regenerate URLs token-by-token
  // and drift rare domains toward plausible ones (janis.ai → native.ai), so
  // links must come from the given context, never be invented.
  parts.push(
    '\nOnly share links that appear verbatim in your knowledge base, documents, or conversation context. If the customer asks for a link you don\'t have, share the site\'s own search page (e.g. https://www.google.com/search?q=your+search) rather than guessing a deep link — never invent a URL or domain.' +
    '\nIf answering exposed knowledge you\'re missing, end your reply with lines starting "LEARN:" describing each missing fact (e.g. "LEARN: returns are accepted within 30 days") — it\'s hidden from the customer and queued for human review.',
  );
  parts.push(
    '\nKeep replies short and conversational — this is a live chat, not an essay. A sentence or three unless the customer asks for detail.',
  );
  if (opts.forSuggestion) {
    parts.push(
      '\nNow write the reply you would send to the customer right now — your single best, most confident answer to their latest message, in your own voice. If details are missing, give the best answer you can and ask one targeted follow-up rather than hedging or deferring. Output only the reply text — no speaker labels, no preamble; never output [HANDOFF] in a draft.',
    );
  } else {
    parts.push(
      '\nEscalation, two levels. If the customer explicitly asks for a human — or just confirmed wanting one after you offered — give the best short answer you can first (a partial answer, a workaround, or what to search for), then end with [HANDOFF] on its own line. If you cannot fully help but they have NOT asked for a human, give your best answer, ask whether they would like a human to step in, and end with [OFFER_HUMAN] on its own line. Never emit [HANDOFF] unless the customer clearly asked for or agreed to a human. If the customer declines an offered human or makes clear they no longer want one, reply briefly and end with [CANCEL_HANDOFF] on its own line.',
    );
  }
  return parts.join('');
}

const LINK_RE = /https?:\/\/[^\s<>"'`()[\]]+/g;
const TRAIL_PUNCT = /[.,;:!?]+$/;

/** URLs the agent was actually given — extracted from its prompt context
 * (system prompt, knowledge, documents). The only links it may share. */
function extractUrls(text: string): string[] {
  return (text.match(LINK_RE) ?? []).map((u) => u.replace(TRAIL_PUNCT, ''));
}

/** Everything a reply may legitimately link to: URLs in the agent's prompt
 * context (system prompt, knowledge, docs) plus URLs that appeared in the
 * conversation itself — customer-shared links and tool outputs are valid to
 * relay. Tool endpoint origins are blessed too, and `allowed_link_domains`
 * in agent config covers links a client's backend returns (tracking URLs,
 * booking links) that never appear verbatim in context. */
export function blessedUrlsFor(agent: AgentRow, prompt: string, history: ChatMsg[]): string[] {
  const urls = extractUrls(prompt);
  for (const m of history) urls.push(...extractUrls(contentText(m.content)));
  for (const t of toolsFor(agent)) urls.push(t.url);
  const cfg = (agent.config ?? {}) as { allowed_link_domains?: string[] };
  for (const d of cfg.allowed_link_domains ?? []) urls.push(`https://${d}/`);
  return urls;
}

const LINK_CHECK_TIMEOUT_MS = 4_000;

/** Only public http(s) hosts may be fetch-checked — emitted URLs are model
 * output, i.e. untrusted input for a server-side request (SSRF). */
function publiclyFetchable(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname;
    if (h.includes(':')) return false; // ipv6 literal — block outright
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(h)) return false;
    if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      if (
        a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

type LinkVerdict = 'ok' | 'dead' | 'unknown';

/** Fetch-check a URL the model emitted that isn't in context. HEAD first,
 * GET fallback. 'ok' resolves, 'dead' is definitively broken (DNS failure,
 * 4xx/5xx, private host), 'unknown' can't be told apart (bot-blocked,
 * timed out, refused — often datacenter-IP filtering). */
async function checkUrl(raw: string): Promise<LinkVerdict> {
  if (!publiclyFetchable(raw)) return 'dead';
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(raw, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
        headers: { 'user-agent': 'Janis-LinkCheck/1.0 (+https://janis.ai)' },
      });
      await res.body?.cancel().catch(() => {});
      if (method === 'HEAD' && (res.status === 405 || res.status === 501)) continue;
      if (res.status < 400) return 'ok';
      if (res.status === 403 || res.status === 429) return 'unknown';
      return 'dead';
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dead'; // no such domain
      return 'unknown'; // refused/reset/timeout — could be IP filtering
    }
  }
  return 'unknown';
}

export interface LinkGuardResult {
  text: string;
  fixed: string[];
  stripped: string[];
  verified: string[];
  unverified: string[];
}

/** Output guard for generated replies. Per emitted URL:
 *  1. On a blessed host (or subdomain) → pass.
 *  2. Unblessed host but the path matches a blessed URL → domain corruption;
 *     swap the origin (app.native.ai/x → app.janis.ai/x).
 *  3. Otherwise fetch-check it — a legit external link resolves and passes;
 *     a hallucinated dead link is stripped; unverifiable links pass but get
 *     flagged so operators can audit. */
export async function guardReplyLinks(
  text: string,
  blessedUrls: string[],
): Promise<LinkGuardResult> {
  const blessed: { origin: string; host: string; path: string }[] = [];
  for (const raw of blessedUrls) {
    try {
      const u = new URL(raw);
      blessed.push({ origin: u.origin, host: u.host, path: u.pathname });
    } catch {
      // malformed entry in knowledge — not usable as a blessing
    }
  }
  const tidy = (s: string) =>
    s
      .replace(/\[([^\]]*)\]\(\s*\)/g, '$1') // markdown link emptied by a strip
      .replace(/ {2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1');
  const isBlessed = (u: URL) =>
    blessed.some((b) => u.host === b.host || u.host.endsWith(`.${b.host}`));
  const repairTarget = (u: URL) =>
    blessed.find((b) => b.path === u.pathname) ?? (u.pathname === '/' ? blessed[0] : undefined);

  // Pass 1: collect the unblessed, unrepairable URLs needing a fetch-check.
  const toCheck = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) {
    const clean = m[0].replace(TRAIL_PUNCT, '');
    try {
      const u = new URL(clean);
      if (!isBlessed(u) && !repairTarget(u)) toCheck.add(clean);
    } catch {
      // unparseable — left as-is below
    }
  }
  const verdicts = new Map<string, LinkVerdict>();
  await Promise.all(
    [...toCheck].map(async (u) => verdicts.set(u, await checkUrl(u))),
  );

  // Pass 2: rewrite.
  const fixed: string[] = [];
  const stripped: string[] = [];
  const verified: string[] = [];
  const unverified: string[] = [];
  const out = text.replace(LINK_RE, (match) => {
    const clean = match.replace(TRAIL_PUNCT, '');
    const trail = match.slice(clean.length);
    let u: URL;
    try {
      u = new URL(clean);
    } catch {
      return match;
    }
    if (isBlessed(u)) return match;
    const target = repairTarget(u);
    if (target) {
      fixed.push(match);
      return `${target.origin}${u.pathname === '/' ? '/' : u.pathname}${u.search}${u.hash}${trail}`;
    }
    const v = verdicts.get(clean) ?? 'unknown';
    if (v === 'ok') {
      verified.push(clean);
      return match;
    }
    if (v === 'unknown') {
      unverified.push(clean);
      return match;
    }
    stripped.push(match);
    return trail;
  });
  return { text: tidy(out), fixed, stripped, verified, unverified };
}

/** "LEARN: …" lines the agent emits to self-report a knowledge gap — stripped
 * from the customer-facing reply, returned for the message payload so the
 * knowledge-gaps UI can surface them for approval. */
export function extractLearns(text: string): { text: string; learns: string[] } {
  const learns: string[] = [];
  const out = text
    .split('\n')
    .filter((line) => {
      const m = line.trim().match(/^LEARN:\s*(.+)$/i);
      if (m) {
        learns.push(m[1].trim());
        return false;
      }
      return true;
    })
    .join('\n');
  return { text: out.trim(), learns };
}

const LINK_GUARD_RETRY =
  'Your previous draft included links that do not work — they were removed, so the reply now points at nothing. ' +
  'Rewrite it: only share a URL that appears in your context, or the site’s own search page ' +
  '(e.g. https://www.google.com/search?q=your+search) — never guess a deep link. ' +
  'If you have no link to share, tell the customer where to look instead.';

/** complete() + link guard; if the guard stripped dead links, give the model
 * one retry with an explanation so the rewrite doesn't promise a link that
 * isn't there. Token counts are summed across both calls. */
async function generateReply(
  llm: LlmSettings,
  prompt: string,
  msgs: { role: string; content: string | ContentPart[] }[],
  blessedUrls: string[],
  tools: ToolDef[],
  secrets: Record<string, string>,
  ctx: AgentRunContext | undefined,
  builtins: BuiltinTool[] = [],
  onStall?: () => void,
): Promise<LinkGuardResult & { promptTokens: number; completionTokens: number }> {
  const first = await complete(llm, prompt, msgs, tools, secrets, ctx, builtins, onStall);
  const draft = first.text;
  if (!draft) {
    return { text: '', promptTokens: first.promptTokens, completionTokens: first.completionTokens, fixed: [], stripped: [], verified: [], unverified: [] };
  }
  const guard = await guardReplyLinks(draft, blessedUrls);
  if (!guard.stripped.length) {
    return { promptTokens: first.promptTokens, completionTokens: first.completionTokens, ...guard };
  }
  const retry = await complete(
    llm,
    prompt,
    [
      ...msgs,
      { role: 'assistant', content: draft },
      { role: 'user', content: LINK_GUARD_RETRY },
    ],
    tools,
    secrets,
    ctx,
    builtins,
  ).catch(() => null);
  if (!retry?.text) {
    return { promptTokens: first.promptTokens, completionTokens: first.completionTokens, ...guard };
  }
  const g2 = await guardReplyLinks(retry.text, blessedUrls);
  return {
    promptTokens: first.promptTokens + retry.promptTokens,
    completionTokens: first.completionTokens + retry.completionTokens,
    ...g2,
  };
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

function jsonArg(v: string): unknown {
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

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
  // POST bodies: params are declared type:string, so the model supplies
  // nested structures as JSON text — parse object/array-looking values so
  // APIs get real objects (HubSpot properties, Zendesk ticket), not strings.
  const postBody = Object.fromEntries(
    Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? jsonArg(v) : v]),
  );
  const res = await fetch(url, {
    method: tool.method,
    headers: {
      accept: 'application/json',
      ...(tool.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(tool.method === 'POST' ? { body: JSON.stringify(postBody) } : {}),
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

/** OpenAI-compat multimodal content part — Gemini accepts image_url parts. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ChatMsg = {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

/** Text of a message content — multipart messages join their text parts. */
function contentText(content: ChatMsg['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

/** Rough char length for token estimation when the API omits usage. */
function contentLen(content: ChatMsg['content']): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    // ~1k tokens per image is a reasonable flash-lite estimate
    return content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 4_000), 0);
  }
  return 0;
}

/**
 * Replace assistant+tool_calls / tool-result turns with a plain assistant
 * note. Used when a provider rejects the echoed functionCall parts — the
 * model keeps the context ("I called X and got Y") without the wire format
 * that triggered the rejection.
 */
function flattenToolHistory(msgs: ChatMsg[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m.tool_calls) continue;
    const results: string[] = [];
    while (i + 1 < msgs.length && msgs[i + 1].role === 'tool') {
      const t = msgs.splice(i + 1, 1)[0];
      results.push(`${t.name ?? 'tool'} → ${contentText(t.content).slice(0, 200)}`);
    }
    const note = [contentText(m.content), ...results.map((r) => `(${r})`)].filter(Boolean).join(' ');
    msgs[i] = { role: 'assistant', content: note || '(called tools)' };
  }
}

/** Chat completion with an OpenAI-style tool-call loop (max 4 rounds). */
async function complete(
  llm: LlmSettings,
  system: string,
  history: { role: string; content: string | ContentPart[] }[],
  tools: ToolDef[] = [],
  secrets: Record<string, string> = {},
  ctx?: AgentRunContext,
  builtins: BuiltinTool[] = [],
  onStall?: () => void,
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
    // Server-side builtins (web_search, …) — enabled per agent, run in-process
    ...builtins.map((b) => ({
      type: 'function',
      function: {
        name: b.name,
        description: b.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(b.params ?? {}).map(([k, d]) => [k, { type: 'string', description: d }]),
          ),
          required: Object.keys(b.params ?? {}),
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
    // Retry network timeouts and transient upstream errors (429 / 5xx —
    // Gemini flash often 503s "model overloaded"). 4xx is our problem:
    // surface it immediately instead of retrying an identical bad request.
    let res: Response | undefined;
    let lastErr: unknown;
    let flattenedTools = false;
    // Retry network timeouts and transient upstream errors (429 / 5xx —
    // Gemini flash often 503s "model overloaded"), then fall back to
    // JANIS_LLM_FALLBACK_MODEL if the primary keeps failing.
    const models =
      env.llmFallbackModel && env.llmFallbackModel !== llm.model
        ? [llm.model, env.llmFallbackModel]
        : [llm.model];
    for (const model of models) {
      res = undefined;
      if (model !== models[0]) onStall?.();
      // 15s is generous for a chat completion — a hung connection never
      // resolves, so fail fast and retry onto a fresh socket with jitter.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          res = await fetch(`${llm.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${llm.apiKey}`,
            },
            body: JSON.stringify({
              model,
              max_tokens: 400,
              messages: msgs,
              ...(toolsSchema ? { tools: toolsSchema } : {}),
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          lastErr = err;
          res = undefined;
          if (attempt === 3) break;
          onStall?.();
          await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
          continue;
        }
        if (res.ok) break;
        // Gemini 3 requires echoed thought_signatures on functionCall parts;
        // when the shim omits one, the round-trip is a permanent 400. Flatten
        // the tool turns into a plain assistant note and retry once.
        if (
          res.status === 400 &&
          !flattenedTools &&
          msgs.some((m) => m.tool_calls || m.role === 'tool')
        ) {
          flattenToolHistory(msgs);
          flattenedTools = true;
          continue;
        }
        if (res.status < 500 && res.status !== 429) break;
        if (attempt < 3) {
          onStall?.();
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      if (res?.ok) break;
      // A 4xx won't heal on another model — stop falling over.
      if (res && res.status < 500 && res.status !== 429) break;
    }
    if (!res?.ok) {
      if (!res) throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
      // The provider's error body carries the real reason (bad field,
      // context limit, overloaded model) — keep it so failure notes are
      // diagnosable instead of a bare status code.
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    promptTokens += json.usage?.prompt_tokens ?? Math.ceil(msgs.reduce((n, m) => n + contentLen(m.content), 0) / 4);

    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!calls.length) {
      const text = msg?.content?.trim() ?? null;
      completionTokens += json.usage?.completion_tokens ?? (text ? Math.ceil(text.length / 4) : 0);
      return { text, promptTokens, completionTokens };
    }

    completionTokens += json.usage?.completion_tokens ?? 0;
    // Echo the whole message verbatim — Gemini 3 requires thought_signatures
    // on functionCall parts, and the shim puts them in extra_content at
    // either message or tool-call level. Dropping any of it 400s the next round.
    msgs.push({ ...(msg as ChatMsg), role: 'assistant' });
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      const builtin = builtins.find((b) => b.name === call.function.name);
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        result =
          call.function.name === SAVE_PROFILE_TOOL && ctx
            ? await saveUserProfile(ctx, args)
            : builtin
              ? await builtin.run(
                  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
                  ctx,
                )
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

const RECENT_WINDOW = 20;
const MAX_SUMMARY_SOURCE_CHARS = 24_000;
const SUMMARY_SYSTEM =
  'You maintain a running summary of a customer support conversation. Fold the new messages into the existing summary. Track what the customer asked, what the agent answered or promised, decisions made, contact details shared, and anything still unresolved. Write compact prose under 200 words. Output only the updated summary.';

/** One transcript line for the summarizer — internal notes become markers. */
function summaryLine(m: {
  direction: string;
  text: string | null;
  flags: unknown;
  payload?: unknown;
}): string | null {
  if (!m.text) return null;
  const f = m.flags as {
    failure?: boolean;
    help_requested?: boolean;
    custom_alert?: boolean;
    handoff_offer?: boolean;
    handoff_cancelled?: boolean;
  };
  if (f?.failure || f?.help_requested || f?.custom_alert) {
    return '(passed to a human teammate)';
  }
  if (f?.handoff_offer) {
    return '(a human teammate was offered — awaiting the customer\'s reply)';
  }
  if (f?.handoff_cancelled) {
    return '(the customer declined a human — staying with the agent)';
  }
  if ((m.payload as { via?: string } | undefined)?.via === 'handoff') {
    return '(the customer was told a human teammate is joining)';
  }
  if ((m.payload as { via?: string } | undefined)?.via === 'status') {
    return '(a status update was sent to the customer)';
  }
  if (m.direction === 'human') return `human operator: ${m.text}`;
  return (m.direction === 'in' ? `customer: ${m.text}` : `agent: ${m.text}`) + attachmentNote(m.payload);
}

function attachmentsOf(payload: unknown): AttachmentRef[] {
  return (payload as { attachments?: AttachmentRef[] } | undefined)?.attachments ?? [];
}

/** Attachment names from a message payload, for transcript annotations. */
function attachmentNote(payload: unknown): string {
  const atts = attachmentsOf(payload);
  return atts.length ? ` [attachments: ${atts.map((a) => a.name ?? 'file').join(', ')}]` : '';
}

const MAX_VISION_BYTES = 8 * 1024 * 1024;
const MAX_FILE_TEXT = 4_000;
const MAX_FILE_TEXT_TOTAL = 12_000;
const MAX_ATTS_PER_MSG = 3;
/** Only the most recent attachment-bearing customer turns get real image
 *  parts — older files degrade to name annotations so they don't re-bill
 *  vision tokens on every subsequent reply. */
const VISION_TURNS = 2;

const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-yaml|x-sh|sql|csv|rtf))/i;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|ya?ml|xml|log|ini|cfg|ts|tsx|jsx?|mjs|py|rb|go|rs|java|cs?|h|cpp|sh|sql|html?|css)$/i;

/**
 * Turn stored attachments into LLM content: images become base64 image_url
 * parts (Gemini's OpenAI shim rejects remote URLs — INVALID_ARGUMENT), and
 * text-like files inline their content. Anything else stays a name annotation.
 */
async function attachmentContent(
  db: Db,
  atts: AttachmentRef[],
  vision: boolean,
): Promise<{ parts: ContentPart[]; extraText: string; skipped: string[] }> {
  const parts: ContentPart[] = [];
  const texts: string[] = [];
  const skipped: string[] = [];
  let textBudget = MAX_FILE_TEXT_TOTAL;
  for (const a of atts.slice(0, MAX_ATTS_PER_MSG)) {
    const isImage = a.type.startsWith('image/');
    const key = a.url.startsWith('/uploads/') ? a.url.slice('/uploads/'.length) : undefined;
    if (!key) { skipped.push(a.name); continue; }
    const row = await getUpload(db, key).catch(() => undefined);
    if (!row) { skipped.push(a.name); continue; }
    // bytea arrives as Buffer (postgres) or Uint8Array (PGlite) — normalize
    const data = Buffer.from(row.data);
    if (vision && isImage) {
      if (data.length > MAX_VISION_BYTES) { skipped.push(a.name); continue; }
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${a.type};base64,${data.toString('base64')}` },
      });
      continue;
    }
    if ((TEXT_MIME.test(a.type) || TEXT_EXT.test(a.name)) && textBudget > 0) {
      const text = data.toString('utf8').slice(0, Math.min(MAX_FILE_TEXT, textBudget));
      textBudget -= text.length;
      texts.push(`<file name="${a.name}">\n${text}\n</file>`);
      continue;
    }
    skipped.push(a.name);
  }
  return { parts, extraText: texts.length ? `\n${texts.join('\n')}` : '', skipped };
}

/** File analysis (vision + inline file text) is a paid-plan feature — free
 *  workspaces keep filename annotations only. */
export async function fileAnalysisAllowed(db: Db, workspaceId: string): Promise<boolean> {
  const [ws] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return planFor(ws?.plan) !== PLANS.free;
}

/**
 * Rolling agent memory: messages older than the recent window are folded
 * into conversations.agent_summary by the LLM, so long conversations keep
 * their full context without paying full transcript tokens each turn.
 * summaryUpTo marks the newest message already folded in.
 */
export async function refreshConversationSummary(
  db: Db,
  conv: ConversationRow,
  llm: LlmSettings,
): Promise<{ summary?: string; promptTokens: number; completionTokens: number }> {
  const none = { summary: conv.agentSummary ?? undefined, promptTokens: 0, completionTokens: 0 };

  // The (RECENT_WINDOW+1)th newest message bounds what the window covers
  const [boundary] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(desc(messages.createdAt))
    .offset(RECENT_WINDOW)
    .limit(1);
  if (!boundary) return none;
  if (conv.summaryUpTo && conv.summaryUpTo.getTime() >= boundary.createdAt.getTime()) return none;

  const pending = await db
    .select({
      direction: messages.direction,
      text: messages.text,
      flags: messages.flags,
      payload: messages.payload,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        lte(messages.createdAt, boundary.createdAt),
        ...(conv.summaryUpTo ? [gt(messages.createdAt, conv.summaryUpTo)] : []),
      ),
    )
    .orderBy(asc(messages.createdAt));

  const lines = pending.map(summaryLine).filter((l): l is string => !!l);
  if (!lines.length) {
    await db
      .update(conversations)
      .set({ summaryUpTo: boundary.createdAt })
      .where(eq(conversations.id, conv.id));
    return none;
  }

  const res = await complete(llm, SUMMARY_SYSTEM, [
    {
      role: 'user',
      content: `Existing summary (may be empty):\n${conv.agentSummary ?? '(none)'}\n\nNew messages to fold in:\n${lines.join('\n').slice(0, MAX_SUMMARY_SOURCE_CHARS)}\n\nUpdated summary:`,
    },
  ]);
  if (!res.text) return { ...none, promptTokens: res.promptTokens, completionTokens: res.completionTokens };
  await db
    .update(conversations)
    .set({ agentSummary: res.text.trim(), summaryUpTo: boundary.createdAt })
    .where(eq(conversations.id, conv.id));
  return { summary: res.text.trim(), promptTokens: res.promptTokens, completionTokens: res.completionTokens };
}

/**
 * Greeting intent: the agent writes its own opening line from its persona —
 * no configured text needed. Used when greeting is enabled but unset.
 */
export async function generateGreeting(
  agent: AgentRow,
  channelName?: string,
): Promise<string | null> {
  const cfg = (agent.config ?? {}) as { system_prompt?: string; tone?: string };
  const persona = [cfg.system_prompt, cfg.tone ? `Tone: ${cfg.tone}` : '']
    .filter(Boolean)
    .join('\n\n');
  const system =
    `${persona ? persona + '\n\n' : ''}` +
    `Write a short, warm greeting that ${agent.name} sends the moment a customer opens a new chat` +
    `${channelName ? ` on ${channelName}` : ''}. One or two sentences, under 160 characters. ` +
    `Output only the greeting text — no quotes, no preamble.`;
  const res = await complete(llmFor(agent), system, [{ role: 'user', content: 'Greeting:' }]);
  const text = res.text?.trim().replace(/^["']+|["']+$/g, '');
  return text ? text.slice(0, 480) : null;
}

export async function transcriptFor(
  db: Db,
  convId: string,
  fileAnalysis = false,
): Promise<{ role: string; content: string | ContentPart[] }[]> {
  const rows = (await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_WINDOW))
    .reverse()
    .filter((m) => m.text);

  // Vision budget: the most recent VISION_TURNS attachment-bearing customer
  // messages get real image parts; older ones keep name annotations.
  const fileTurns = fileAnalysis
    ? rows.filter((m) => m.direction === 'in' && attachmentsOf(m.payload).length).length
    : 0;
  let fileIdx = 0;

  const out: { role: string; content: string | ContentPart[] }[] = [];
  for (const m of rows) {
    const f = m.flags as {
      failure?: boolean;
      help_requested?: boolean;
      custom_alert?: boolean;
      handoff_offer?: boolean;
    };
    // Internal notes (failures/handoffs/alerts) must not be fed verbatim —
    // the model parrots them. But dropping them entirely leaves the
    // triggering request looking unanswered, so the model hands off again
    // on every later message. A neutral marker closes the turn instead.
    if (f?.failure || f?.help_requested || f?.custom_alert) {
      out.push({ role: 'assistant', content: '(passed to a human teammate)' });
      continue;
    }
    if (f?.handoff_offer) {
      out.push({
        role: 'assistant',
        content:
          "(a human teammate was offered — if the customer declines, end your reply with [CANCEL_HANDOFF])",
      });
      continue;
    }
    // Courtesy notices go verbatim into history and make the model think
    // handoff is the standing state — it then re-escalates trivial
    // follow-ups. A marker conveys the fact without the phrasing.
    if ((m.payload as { via?: string })?.via === 'handoff') {
      out.push({ role: 'assistant', content: '(the customer was told a human teammate is joining)' });
      continue;
    }
    // Stall notes verbatim would teach the model to greet delays it didn't
    // cause — a marker keeps the fact without the phrasing.
    if ((m.payload as { via?: string })?.via === 'status') {
      out.push({ role: 'assistant', content: '(a status update was sent to the customer)' });
      continue;
    }
    const atts = m.direction === 'in' ? attachmentsOf(m.payload) : [];
    if (atts.length && fileAnalysis) {
      const vision = fileIdx++ >= fileTurns - VISION_TURNS;
      const { parts, extraText, skipped } = await attachmentContent(db, atts, vision);
      console.log(
        `[files] attachments=${atts.length} vision=${vision} parts=${parts.length}` +
          `${skipped.length ? ` skipped=${skipped.join(',')}` : ''}` +
          `${parts.length ? ` bytes=${parts.map((p) => (p.type === 'image_url' ? p.image_url.url.length : 0)).join('+')}` : ''}`,
      );
      const text =
        m.text! +
        extraText +
        (skipped.length ? ` [attachments: ${skipped.join(', ')}]` : '');
      out.push(
        parts.length
          ? { role: 'user', content: [{ type: 'text' as const, text }, ...parts] }
          : { role: 'user', content: text },
      );
      continue;
    }
    out.push({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content:
        (m.direction === 'human' ? `(human operator) ${m.text}` : m.text!) +
        attachmentNote(m.payload),
    });
  }
  return out;
}

/** Fold older messages into the running summary — best-effort, never blocks a reply. */
async function foldConversationMemory(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
  llm: LlmSettings,
): Promise<void> {
  try {
    const mem = await refreshConversationSummary(db, conv, llm);
    if (mem.summary) conv.agentSummary = mem.summary;
    if (mem.promptTokens || mem.completionTokens) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: conv.id,
        model: llm.model,
        promptTokens: mem.promptTokens,
        completionTokens: mem.completionTokens,
        byok: llm.byok,
      });
    }
  } catch {
    // summarization is an enhancement — a failure just means less memory
  }
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
    void foldConversationMemory(db, agent, conv, llm);
    const history = await transcriptFor(db, convId, await fileAnalysisAllowed(db, agent.workspaceId));
    const docs = await loadKnowledgeDocs(db, agent.id);
    const secrets = {
      ...(await loadSecretsMap(db, agent.id)),
      ...(await connectionSecrets(db, agent.id)),
    };
    const ctx: AgentRunContext = { db, convId, workspaceId: agent.workspaceId };
    const prompt = systemPrompt(agent, docs, conv, { forSuggestion: true });
    const blessedUrls = blessedUrlsFor(agent, prompt, history);
    const result = await generateReply(
      llm,
      prompt,
      history,
      blessedUrls,
      toolsFor(agent),
      secrets,
      ctx,
      enabledBuiltins(
        ((agent.config ?? {}) as { builtin_tools?: string[] }).builtin_tools,
        agent.workspaceId,
      ),
    ).catch(() => null);
    if (result) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        byok: llm.byok,
      });
    }
    // The model sometimes mimics the transcript's speaker labels
    // ("(human operator) ...") — strip any leading role prefix.
    const stripLabel = (t?: string | null) =>
      t?.replace(/^\s*\(?(human operator|operator|agent|assistant)\)?\s*[:\-–—]\s*/i, '') ?? undefined;
    let draft = stripLabel(result?.text);
    if (draft && /\[(HANDOFF|OFFER_HUMAN|CANCEL_HANDOFF)\]/.test(draft)) draft = undefined;

    if (!draft) {
      // Escalated conversations prime the model to emit [HANDOFF] no matter
      // what the directive says — retry with a minimal ask, no transcript.
      const lastCustomerMsg = contentText(
        [...history].reverse().find((m) => m.role === 'user')?.content ?? null,
      );
      const retry = lastCustomerMsg
        ? await complete(
            llm,
            prompt,
            [
              {
                role: 'user',
                content: `The customer said: "${lastCustomerMsg}". Draft the agent's reply — output only the reply text.`,
              },
            ],
            [],
            secrets,
            ctx,
          ).catch(() => null)
        : null;
      if (retry && (retry.promptTokens || retry.completionTokens)) {
        await recordLlmUsage(db, {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          conversationId: convId,
          model: llm.model,
          promptTokens: retry.promptTokens,
          completionTokens: retry.completionTokens,
          byok: llm.byok,
        });
      }
      draft = stripLabel(retry?.text);
      if (draft && /\[(HANDOFF|OFFER_HUMAN|CANCEL_HANDOFF)\]/.test(draft)) draft = undefined;
    }

    const text =
      draft ??
      'I want to make sure we get this right — let me look into it and follow up shortly.';
    await storeSuggestion(
      db,
      convId,
      extractLearns((await guardReplyLinks(text, blessedUrls)).text).text,
      'agent',
    );
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
  // Only a human takeover silences the agent — needs_human is a flag for
  // attention, archived is inbox organization; neither pauses replies.
  if (!conv || conv.state === 'human') return;

  // Legacy engines: migrated wordhopapi bots. 'monitor' bots (Chatfuel-era —
  // the bot platform replies on its own) never answer; 'dialogflow' bots
  // answer via their imported DF agent.
  const engine = (agent.config as { engine?: string }).engine;
  if (engine === 'monitor') return;
  if (engine === 'dialogflow') {
    await runLegacyReply(db, agent, event, conv);
    return;
  }

  // Serialize replies per conversation — overlapping runs each answer the
  // same unanswered message, producing double replies. A message landing
  // mid-run marks pending and coalesces into one follow-up pass that sees
  // the fresh transcript.
  const run = convRuns.get(convId) ?? { running: false, pending: false };
  convRuns.set(convId, run);
  if (run.running) {
    run.pending = true;
    return;
  }
  run.running = true;
  try {
    do {
      run.pending = false;
      // Re-check ownership — a human may have taken over mid-run.
      const [fresh] = await db
        .select({ state: conversations.state })
        .from(conversations)
        .where(eq(conversations.id, convId))
        .limit(1);
      if (!fresh || fresh.state === 'human') break;
      await replyAsHostedAgent(db, agent, conv);
    } while (run.pending);
  } finally {
    run.running = false;
    convRuns.delete(convId);
  }
}

const convRuns = new Map<string, { running: boolean; pending: boolean }>();

// Interim line while the LLM call is being retried — buys goodwill during a
// provider stall instead of leaving the customer staring at silence.
const STALL_LINES = [
  'Still working on that for you — one moment.',
  'On it — just taking a little longer than usual.',
  'Hang tight, still looking into that.',
];

// Final failure: offer a human rather than auto-escalating — the customer
// chooses, and a "yes" lands as a normal turn the agent can hand off on.
const FAILURE_LINES = [
  "I'm having trouble answering that properly right now — would you like me to get a human?",
  "I can't give you a good answer just yet. Want me to bring in a human teammate?",
  'Sorry — something went wrong on my end. Should I get a human to help?',
];

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

// Tappable yes/no attached to every "want a human?" offer — webchat chips,
// native quick replies on Meta channels.
const OFFER_CHOICES = ['Yes, get a human', 'No thanks'];

async function replyAsHostedAgent(
  db: Db,
  agent: AgentRow,
  conv: ConversationRow,
): Promise<void> {
  const convId = conv.id;
  const externalId = conv.externalId;
  const t0 = Date.now();
  const emit = (e: Parameters<typeof processEvents>[2]) => processEvents(db, agent, e);

  try {
    const llm = llmFor(agent);
    // Fold memory alongside the reply — the summary only matters for future
    // turns, so blocking on it adds a whole LLM call to every reply.
    void foldConversationMemory(db, agent, conv, llm);
    const fileAnalysis = await fileAnalysisAllowed(db, agent.workspaceId);
    console.log(`[files] conv=${convId} analysis=${fileAnalysis}`);
    const history = await transcriptFor(db, convId, fileAnalysis);
    const docs = await loadKnowledgeDocs(db, agent.id);
    const secrets = {
      ...(await loadSecretsMap(db, agent.id)),
      ...(await connectionSecrets(db, agent.id)),
    };
    const ctx: AgentRunContext = { db, convId, workspaceId: agent.workspaceId };
    const prompt = systemPrompt(agent, docs, conv);
    const blessedUrls = blessedUrlsFor(agent, prompt, history);
    let stalled = false;
    const onStall = () => {
      if (stalled) return;
      stalled = true;
      void emit([
        {
          type: 'message_out',
          conversation_id: externalId,
          text: pick(STALL_LINES),
          payload: { via: 'status' },
        },
      ]);
    };
    const gen = await generateReply(
      llm,
      prompt,
      history,
      blessedUrls,
      toolsFor(agent),
      secrets,
      ctx,
      enabledBuiltins(
        ((agent.config ?? {}) as { builtin_tools?: string[] }).builtin_tools,
        agent.workspaceId,
      ),
      onStall,
    );
    const { text: guardedReply, promptTokens, completionTokens } = gen;
    const { text: reply, learns } = extractLearns(guardedReply);
    const learnFlag = learns.length ? { learn: learns } : {};
    if (promptTokens || completionTokens) {
      await recordLlmUsage(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        conversationId: convId,
        model: llm.model,
        promptTokens,
        completionTokens,
        byok: llm.byok,
      });
    }
    if (!reply) {
      await emit([
        { type: 'handoff_request', conversation_id: externalId, reason: 'no LLM configured or empty reply' },
      ]);
      return;
    }
    if (gen.fixed.length || gen.stripped.length || gen.unverified.length) {
      console.warn(
        `[hosted] link guard conv=${convId} fixed=${gen.fixed.length} stripped=${gen.stripped.length} verified=${gen.verified.length} unverified=${gen.unverified.length}`,
      );
    }
    const linkFlag = {
      ...(gen.fixed.length || gen.stripped.length || gen.verified.length || gen.unverified.length
        ? {
            link_guard: {
              fixed: gen.fixed,
              stripped: gen.stripped,
              verified: gen.verified,
              unverified: gen.unverified,
            },
          }
        : {}),
      ...learnFlag,
    };
    // A tapped "No thanks" chip is an explicit decline — de-escalate even if
    // the model forgets (or misfires [HANDOFF] on) the tag. Only fires while
    // an escalation is actually pending: needs_human or an open handoff alert.
    const lastCustomerText = contentText(
      [...history].reverse().find((m) => m.role === 'user')?.content ?? null,
    )
      ?.trim()
      .toLowerCase();
    const declineTapped =
      lastCustomerText === 'no thanks' &&
      (conv.state === 'needs_human' ||
        !!(await db
          .select({ id: alerts.id })
          .from(alerts)
          .where(
            and(
              eq(alerts.conversationId, convId),
              eq(alerts.status, 'open'),
              inArray(alerts.type, ['help_request', 'handoff_offer']),
            ),
          )
          .limit(1))[0]);
    if (declineTapped || reply.includes('[CANCEL_HANDOFF]')) {
      // Customer declined a human — deliver the reply and de-escalate any
      // pending handoff/offer back to the agent.
      const partial = reply.replace(/\[CANCEL_HANDOFF\]/g, '').trim();
      const events: Parameters<typeof processEvents>[2] = [];
      if (partial) {
        events.push({
          type: 'message_out',
          conversation_id: externalId,
          text: partial,
          payload: { via: 'hosted', ...linkFlag },
        });
      }
      events.push({
        type: 'handoff_cancelled',
        conversation_id: externalId,
        reason: 'customer declined a human',
      });
      await emit(events);
      return;
    }
    if (reply.includes('[HANDOFF]')) {
      // The model may pair the tag with a partial answer — deliver it so the
      // customer gets more than the bare "human is on the way" notice, then
      // still flag the handoff.
      const partial = reply.replace(/\[HANDOFF\]/g, '').trim();
      const events: Parameters<typeof processEvents>[2] = [];
      if (partial) {
        events.push({
          type: 'message_out',
          conversation_id: externalId,
          text: partial,
          payload: { via: 'hosted', ...linkFlag },
        });
      }
      events.push({
        type: 'handoff_request',
        conversation_id: externalId,
        reason: 'agent signalled handoff',
      });
      await emit(events);
      return;
    }
    if (reply.includes('[OFFER_HUMAN]')) {
      // Agent thinks a human would help but the customer hasn't asked —
      // deliver the reply (which should include the offer question) and
      // fire a non-escalating handoff_offer alert so operators can peek.
      const partial = reply.replace(/\[OFFER_HUMAN\]/g, '').trim();
      const events: Parameters<typeof processEvents>[2] = [];
      if (partial) {
        events.push({
          type: 'message_out',
          conversation_id: externalId,
          text: partial,
          payload: { via: 'hosted', quick_replies: OFFER_CHOICES, ...linkFlag },
        });
      }
      events.push({
        type: 'handoff_offer',
        conversation_id: externalId,
        reason: 'agent offered a human — awaiting customer reply',
      });
      await emit(events);
      return;
    }
    await emit([
      { type: 'message_out', conversation_id: externalId, text: reply, payload: { via: 'hosted', ...linkFlag } },
    ]);
    console.log(`[hosted] ${agent.name} replied in ${Date.now() - t0}ms`);
  } catch (err) {
    // Agent errored — alert operators (failure alert) and offer the customer a
    // human, but don't seize the conversation: it stays 'active' so the agent
    // answers the next message if the provider recovers.
    await emit([
      { type: 'failure', conversation_id: externalId, reason: err instanceof Error ? err.message : 'generation failed' },
      {
        type: 'message_out',
        conversation_id: externalId,
        text: pick(FAILURE_LINES),
        payload: { via: 'hosted', quick_replies: OFFER_CHOICES },
      },
    ]);
  }
}
