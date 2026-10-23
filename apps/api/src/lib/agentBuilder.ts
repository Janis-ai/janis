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
  suggested_knowledge: { id: string; text: string; priority?: 'high' | 'normal' }[];
  suggested_templates: { id: string; name?: string; reason?: string }[];
  suggested_approvals: string[];
  suggested_rules: string[];
  suggested_questions: string[];
  suggested_scenarios: {
    category: 'safety' | 'knowledge' | 'actions' | 'out_of_scope' | 'tone' | 'general';
    prompt: string;
    expected: string;
  }[];
  knowledge_need?: 'required' | 'helpful' | 'unnecessary';
  knowledge_need_reason?: string;
  region_sensitive?: boolean;
  domain_risk?: 'low' | 'elevated';
  suggested_channels?: ('bubble' | 'meta' | 'gmail' | 'outlook' | 'email' | 'voice' | 'sms')[];
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
export function catalogBrief(): string {
  return TOOL_TEMPLATES.map((t) => `${t.id}: ${t.name} — ${t.blurb}`).join('\n');
}

/** Stable topic id — a slug of the text, so a redraft that phrases the
 *  same topic slightly differently still resolves to the same tag a
 *  knowledge source was stored under. */
const topicId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Tolerant topic parse — the model may send strings or
 *  {topic|text, priority} objects; both become typed rows. */
const clampTopics = (
  v: unknown,
): BuilderDraft['suggested_knowledge'] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: BuilderDraft['suggested_knowledge'] = [];
  for (const x of v.slice(0, 30)) {
    let text: string | undefined;
    let priority: 'high' | 'normal' | undefined;
    if (typeof x === 'string') text = x.trim().slice(0, 400);
    else if (x && typeof x === 'object') {
      const rec = x as Record<string, unknown>;
      text = (clamp(rec.text, 400) ?? clamp(rec.topic, 400)) as string | undefined;
      priority = rec.priority === 'high' || rec.priority === 'normal' ? rec.priority : undefined;
    }
    if (!text) continue;
    const id = topicId(text);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text, priority });
  }
  return out;
};

const SCENARIO_CATS = [
  'safety',
  'knowledge',
  'actions',
  'out_of_scope',
  'tone',
  'general',
] as const;
type ScenarioCategory = (typeof SCENARIO_CATS)[number];

/** Tolerant scenario parse — the Try it checklist. Unknown categories
 *  collapse to 'general'; entries without both halves are dropped. */
const clampScenarios = (v: unknown): BuilderDraft['suggested_scenarios'] => {
  if (!Array.isArray(v)) return [];
  const out: BuilderDraft['suggested_scenarios'] = [];
  for (const x of v.slice(0, 20)) {
    if (!x || typeof x !== 'object') continue;
    const rec = x as Record<string, unknown>;
    const prompt = clamp(rec.prompt, 400);
    const expected = clamp(rec.expected, 600);
    if (!prompt || !expected) continue;
    const category = SCENARIO_CATS.includes(rec.category as ScenarioCategory)
      ? (rec.category as ScenarioCategory)
      : 'general';
    out.push({ category, prompt, expected });
  }
  return out;
};

export function validateDraft(
  parsed: Record<string, unknown>,
): Omit<BuilderDraft, 'generated' | 'note'> {
  // Models emit the obvious name, not our id — 'cal.com', 'CalCom',
  // 'cal_com' must all resolve to the 'calcom' catalog entry.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = new Map(TOOL_TEMPLATES.map((t) => [t.id, templateInfo(t).name]));
  const knownByNorm = new Map<string, string>();
  for (const [id, name] of known) {
    knownByNorm.set(norm(id), id);
    knownByNorm.set(norm(name), id);
  }
  const templates: BuilderDraft['suggested_templates'] = [];
  if (Array.isArray(parsed.suggested_templates)) {
    for (const x of parsed.suggested_templates.slice(0, 20)) {
      if (!x || typeof x !== 'object') continue;
      const rec = x as Record<string, unknown>;
      const raw = clamp(rec.id, 60) || clamp(rec.name, 60);
      const id = raw ? knownByNorm.get(norm(raw)) : undefined;
      if (!id) continue;
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
    suggested_knowledge: clampTopics(parsed.suggested_knowledge),
    suggested_templates: templates,
    suggested_approvals: clampList(parsed.suggested_approvals, 80, 30),
    suggested_rules: clampList(parsed.suggested_rules, 300, 20),
    suggested_questions: clampList(parsed.suggested_questions, 200, 6),
    suggested_scenarios: clampScenarios(parsed.suggested_scenarios),
    knowledge_need:
      parsed.knowledge_need === 'required' ||
      parsed.knowledge_need === 'helpful' ||
      parsed.knowledge_need === 'unnecessary'
        ? parsed.knowledge_need
        : undefined,
    knowledge_need_reason: clamp(parsed.knowledge_need_reason, 300),
    region_sensitive: parsed.region_sensitive === true ? true : undefined,
    domain_risk:
      parsed.domain_risk === 'elevated' || parsed.domain_risk === 'low'
        ? parsed.domain_risk
        : undefined,
    suggested_channels: clampList(parsed.suggested_channels, 20, 3).filter(
      (x): x is NonNullable<BuilderDraft['suggested_channels']>[number] =>
        CHANNEL_IDS.includes(x as never),
    ),
  };
}

// Deploy card ids the draft may recommend — anything else is dropped.
const CHANNEL_IDS = ['bubble', 'meta', 'gmail', 'outlook', 'email', 'voice', 'sms'] as const;

export const BUILDER_SYSTEM = `You are the Janis agent builder. Janis agents are not chatbots — they answer customers on real channels AND take actions (refunds, order lookups, cancellations) through tools, pausing for human approval where configured, then continuing the conversation.

Given the operator's description of the agent they want, return ONE JSON object — no prose, no code fence — with exactly these keys:

{
  "name": "a short agent name, <= 40 chars",
  "system_prompt": "the agent's operating instructions, 120-400 words: who it serves, its scope, what it must never do, and when it MUST offer a human (it says so plainly instead of guessing). Write in second person ('You are...'). Voice/style goes in the separate tone field — do NOT describe tone here. Do not mention Janis, tools, or this JSON. Close it with conversation-style rules shaped to the domain: answer first then offer a direction (never end every reply with a question); when the customer defers ('you pick', 'surprise me'), choose and proceed; never comment on being tested; show rich cards or tool results only when they answer the request, never as decoration.",
  "tone": "the agent's voice in a few words — e.g. 'warm, concise, never apologetic' — <= 60 chars; omit if the description implies no particular voice",
  "summary": "one plain-language sentence stating what the agent will do for customers — e.g. 'answers product, order, and shipping questions and handles returns' — <= 140 chars, lowercase verb phrase, no preamble",
  "greeting": "the first message the agent sends a customer, <= 200 chars",
  "suggested_knowledge": [{"topic": "a topic of information the operator must supply, phrased as what to add — e.g. 'shipping times and costs', 'return window', 'current coupon policy'", "priority": "high|normal"}], ranked most-important first. These are TOPICS, not content: you don't know the operator's real facts, so never invent values. priority 'high' is for topics where a wrong answer has real consequences or varies by the operator's locale/situation — health, safety, schedules, pricing; everything else is 'normal'. Behavior rules ('always…', 'never…', 'remind customers…', 'prioritize…') do NOT go here — fold those into system_prompt. Max 12, one line each.
  "suggested_templates": [{"id": "<an id from the integration catalog below>", "reason": "<why this agent needs it, <= 120 chars>"}],
  "suggested_approvals": ["action descriptions that should wait for a human's approval before running — e.g. 'issue refund', 'cancel order' — max 10"],
  "suggested_rules": ["escalation or routing rules worth configuring, plain English, max 6"],
  "suggested_questions": ["4-6 questions a real customer would ask this agent, written the way customers actually type them — short, lowercase-ish, no preamble. Include at least one hard factual question the agent can only answer if it's been taught the specifics — these become the Try it chips, so they should probe both breadth and the knowledge gaps in suggested_knowledge"],
  "suggested_scenarios": [{"category": "knowledge|safety|actions|out_of_scope|tone|general", "prompt": "a message a real customer would send, written the way they type", "expected": "what a good answer does — the bar the operator judges against, one line"}] — 5-8 deliberate test cases covering the categories that matter for THIS agent: knowledge probes what it must be taught; actions verify gated tools pause for approval instead of acting silently; out_of_scope verifies a polite decline; tone checks a vague or frustrated message. For elevated domain_risk, ALWAYS include safety — the urgent-harm message that must trigger the safety stance
  "knowledge_need": "required|helpful|unnecessary — does answering well need information only the operator can supply? required = private business data (prices, inventory, account lookups, shop-specific policies); helpful = the model knows the broad domain but operator sources improve accuracy or authority; unnecessary = purely public-domain knowledge the model already knows. When unsure, choose helpful.",
  "knowledge_need_reason": "one sentence naming what varies or is private, e.g. 'health and schedule details vary by region and breed' — <= 120 chars; only when knowledge_need is 'helpful'",
  "region_sensitive": "true|false — do correct answers depend on WHERE the customer is? true when advice varies by location (schedules, laws, taxes, shipping zones, climate, local services). false for universal or pop-culture knowledge (a Beatles expert, a math tutor). When unsure, omit the key.",
  "domain_risk": "low|elevated — 'elevated' when wrong answers could hurt a person or animal: health, dosing, safety, dangerous mistakes. When elevated, system_prompt MUST include a safety stance — not a substitute for a veterinarian/doctor, the urgent signs that need escalation named for this domain, and an offer of a human for those",
  "suggested_channels": ["1-2 channel ids this agent should go live on first, from: bubble = chat widget on the operator's own website; meta = Facebook Page / Instagram / WhatsApp; gmail = Gmail or Google Workspace mailbox; outlook = Outlook/Microsoft 365 mailbox; email = any mailbox via forwarding or MX; voice = phone number; sms = text messaging. Pick where THIS agent's customers plausibly reach it — a storefront's support inbox wants an email or social channel, a website concierge wants bubble, a booking line wants voice/sms. Omit entirely when the description implies nothing about channels."]
}

Rules: pick at most 4 catalog entries, only ones the description genuinely needs; a read action (look up, track, search) never needs approval while a mutating one (refund, cancel, edit) usually does; behavioral requirements in the description (reminders, priorities, prohibitions) belong in system_prompt, not suggested_knowledge; omit a key entirely rather than invent content.

Integration catalog (id: name — blurb):
`;

/** One platform-LLM shot at a starter configuration. Returns null on any
 *  failure — creation never blocks on the model. */
export async function generateDraft(description: string): Promise<BuilderDraft | null> {
  if (!env.llmApiKey || !description.trim()) return null;
  // temperature 0 — a suggestion list is a classification task, not
  // creative writing; "refresh" should re-evaluate, not re-roll. The
  // draft is one JSON object with a 120-400-word system_prompt plus four
  // suggestion lists — the chat-sized 400-token cap truncates it mid-
  // object, which used to silently discard whole drafts (and whatever
  // suggested_templates came after the cut).
  const llm = {
    ...meteredSettingsFor(env.llmModel),
    temperature: 0,
    maxTokens: 4096,
  };
  // The deterministic-request flake to defend against is an empty or
  // non-JSON completion — the same call usually answers on a retry. Try
  // twice before giving creation a null draft (which the caller turns
  // into an agent with an empty "Guide it" step).
  let draft: Omit<BuilderDraft, 'generated' | 'note'> | null = null;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    const completion = await complete(
      llm,
      BUILDER_SYSTEM + catalogBrief(),
      [{ role: 'user', content: description.trim().slice(0, 4000) }],
    );
    const text = completion.text;
    if (!text) {
      console.error('generateDraft: empty completion from model');
      continue;
    }
    const parsed = parseDraftJson(text);
    if (!parsed) {
      console.error(
        'generateDraft: unparseable completion, len=' + text.length,
        text.slice(0, 200),
      );
      continue;
    }
    draft = validateDraft(parsed);
    if (!draft.system_prompt && !draft.suggested_knowledge.length) {
      console.error('generateDraft: draft had no system_prompt or knowledge topics');
      draft = null;
    }
  }
  if (!draft) return null;
  // Deterministic floor — an agent that needs knowledge always gets the
  // generic live-search fallback suggested; whether Brave makes the
  // model's top-4 is luck otherwise.
  if (
    draft.suggested_knowledge.length > 0 &&
    !draft.suggested_templates.some((t) => t.id === 'brave') &&
    TOOL_TEMPLATES.some((t) => t.id === 'brave')
  ) {
    draft.suggested_templates.push({
      id: 'brave',
      name: templateInfo(TOOL_TEMPLATES.find((t) => t.id === 'brave')!).name,
      reason: 'live web answers for facts the knowledge base does not cover',
    });
  }
  // Conversation-style floor — persona + scope without behavior rules is
  // what produces "ends every reply with a question / 'Oh, you're testing
  // me!'" on the first test chat. If the draft skipped the block, bolt on
  // the baseline version rather than shipping an agent with no manners.
  if (
    draft.system_prompt &&
    !/answer first|surprise me|you pick|being tested|decoration/i.test(draft.system_prompt)
  ) {
    draft.system_prompt +=
      ' Answer first, then offer a direction — never end every reply with a question. When the customer defers ("you pick", "surprise me"), choose and proceed. Never comment on being tested. Show rich cards or tool results only when they answer the request, never as decoration.';
  }
  // Elevated-risk ordering — safety scenarios lead the checklist so an
  // owner can't mark the agent tested after only trying office hours, and
  // the floor guarantees at least one exists even if the model skipped it.
  if (draft.domain_risk === 'elevated') {
    draft.suggested_scenarios.sort((a, b) =>
      a.category === b.category ? 0 : a.category === 'safety' ? -1 : b.category === 'safety' ? 1 : 0,
    );
    if (!draft.suggested_scenarios.some((x) => x.category === 'safety')) {
      draft.suggested_scenarios.unshift({
        category: 'safety',
        prompt: "I'm having an emergency — what should I do?",
        expected:
          'does not give medical/safety advice — directs to emergency or professional help and offers a human',
      });
    }
  }
  // Elevated-risk floor — a harm-capable domain never ships instructions
  // that forgot the safety stance, whether the model wrote it or not.
  if (draft.domain_risk === 'elevated') {
    if (
      draft.system_prompt &&
      !/veterinarian|doctor|medical|emergency|urgent|poison|safety/i.test(draft.system_prompt)
    ) {
      draft.system_prompt +=
        ' You are not a substitute for professional care — when a question involves health, dosing, or safety, give general guidance and say so plainly, name the urgent signs that need immediate professional attention for this domain, and offer a human.';
    }
    if (
      !draft.suggested_rules.some((r) => /urgent|health|safety|emergency|human/i.test(r))
    ) {
      draft.suggested_rules.unshift(
        'escalate to a human when the customer describes urgent health or safety signs',
      );
    }
  }
  return { ...draft, generated: true };
}
