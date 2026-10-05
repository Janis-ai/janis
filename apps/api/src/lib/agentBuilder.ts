import { env } from '../env.js';
import { meteredSettingsFor } from './llm.js';
import { complete } from './hostedAgent.js';
import { TOOL_TEMPLATES, templateInfo } from './toolTemplates.js';

/** What the guided builder asks the model to draft from the operator's
 *  natural-language purpose. Suggestions stay suggestions — templates
 *  still need install/credentials, approvals still get ticked, rules still
 *  get created — so a bad draft can never quietly arm an action. */
export interface BuilderDraft {
  name?: string;
  system_prompt?: string;
  tone?: string;
  greeting?: string;
  summary?: string;
  suggested_knowledge: string[];
  suggested_templates: { id: string; name?: string; reason?: string }[];
  suggested_approvals: string[];
  suggested_rules: string[];
  generated: boolean;
  note?: string;
}

const clamp = (v: unknown, n: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, n) : undefined;
};

const clampList = (v: unknown, item: number, count: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === 'string' ? x.trim().slice(0, item) : ''))
        .filter(Boolean)
        .slice(0, count)
    : [];

/** Tolerant JSON extraction — the model is told JSON-only but may wrap it
 *  in prose or a code fence; take the outermost balanced-ish object. */
export function parseDraftJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The catalog goes into the generation prompt so suggested_templates are
 *  real installable ids — validated again on the way out, so a hallucinated
 *  id is dropped, never installed. */
function catalogBrief(): string {
  return TOOL_TEMPLATES.map((t) => `${t.id}: ${t.name} — ${t.blurb}`).join('\n');
}

export function validateDraft(
  parsed: Record<string, unknown>,
): Omit<BuilderDraft, 'generated' | 'note'> {
  const known = new Map(TOOL_TEMPLATES.map((t) => [t.id, templateInfo(t).name]));
  const templates: BuilderDraft['suggested_templates'] = [];
  if (Array.isArray(parsed.suggested_templates)) {
    for (const x of parsed.suggested_templates.slice(0, 20)) {
      if (!x || typeof x !== 'object') continue;
      const id = clamp((x as Record<string, unknown>).id, 60);
      if (!id || !known.has(id)) continue;
      templates.push({
        id,
        name: known.get(id),
        reason: clamp((x as Record<string, unknown>).reason, 300),
      });
    }
  }
  return {
    name: clamp(parsed.name, 60),
    system_prompt: clamp(parsed.system_prompt, 8000),
    tone: clamp(parsed.tone, 200),
    greeting: clamp(parsed.greeting, 500),
    summary: clamp(parsed.summary, 300),
    suggested_knowledge: clampList(parsed.suggested_knowledge, 400, 30),
    suggested_templates: templates,
    suggested_approvals: clampList(parsed.suggested_approvals, 80, 30),
    suggested_rules: clampList(parsed.suggested_rules, 300, 20),
  };
}

const BUILDER_SYSTEM = `You are the Janis agent builder. Janis agents are not chatbots — they answer customers on real channels AND take actions (refunds, order lookups, cancellations) through tools, pausing for human approval where configured, then continuing the conversation.

Given the operator's description of the agent they want, return ONE JSON object — no prose, no code fence — with exactly these keys:

{
  "name": "a short agent name, <= 40 chars",
  "system_prompt": "the agent's operating instructions, 120-400 words: who it serves, its scope, what it must never do, and when it MUST offer a human (it says so plainly instead of guessing). Write in second person ('You are...'). Voice/style goes in the separate tone field — do NOT describe tone here. Do not mention Janis, tools, or this JSON.",
  "tone": "the agent's voice in a few words — e.g. 'warm, concise, never apologetic' — <= 60 chars; omit if the description implies no particular voice",
  "summary": "one plain-language sentence stating what the agent will do for customers — e.g. 'answers product, order, and shipping questions and handles returns' — <= 140 chars, lowercase verb phrase, no preamble",
  "greeting": "the first message the agent sends a customer, <= 200 chars",
  "suggested_knowledge": ["topics of information the operator must supply, phrased as what to add — e.g. 'shipping times and costs', 'return window', 'current coupon policy'. These are TOPICS, not content: you don't know the operator's real facts, so never invent values. Behavior rules ('always…', 'never…', 'remind customers…', 'prioritize…') do NOT go here — fold those into system_prompt. Max 12, one line each."],
  "suggested_templates": [{"id": "<an id from the integration catalog below>", "reason": "<why this agent needs it, <= 120 chars>"}],
  "suggested_approvals": ["action descriptions that should wait for a human's approval before running — e.g. 'issue refund', 'cancel order' — max 10"],
  "suggested_rules": ["escalation or routing rules worth configuring, plain English, max 6"]
}

Rules: pick at most 4 catalog entries, only ones the description genuinely needs; a read action (look up, track, search) never needs approval while a mutating one (refund, cancel, edit) usually does; behavioral requirements in the description (reminders, priorities, prohibitions) belong in system_prompt, not suggested_knowledge; omit a key entirely rather than invent content.

Integration catalog (id: name — blurb):
`;

/** One platform-LLM shot at a starter configuration. Returns null on any
 *  failure — creation never blocks on the model. */
export async function generateDraft(description: string): Promise<BuilderDraft | null> {
  if (!env.llmApiKey || !description.trim()) return null;
  const llm = meteredSettingsFor(env.llmModel);
  const completion = await complete(
    llm,
    BUILDER_SYSTEM + catalogBrief(),
    [{ role: 'user', content: description.trim().slice(0, 4000) }],
  );
  const text = completion.text;
  if (!text) return null;
  const parsed = parseDraftJson(text);
  if (!parsed) return null;
  const draft = validateDraft(parsed);
  if (!draft.system_prompt && !draft.suggested_knowledge.length) return null;
  return { ...draft, generated: true };
}
