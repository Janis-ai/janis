/**
 * @janis/agent-template — a Janis-ready support agent.
 *
 * Boots from the agent's config in Janis (system prompt, knowledge, tone),
 * answers `message.user` webhooks from hosted channels, drafts suggestions,
 * and honors the takeover contract: while `paused`, it stays quiet.
 *
 * Env:
 *   JANIS_API_KEY     agent api key (required)
 *   JANIS_BASE_URL    api origin (default http://localhost:8787)
 *   JANIS_WEBHOOK_SECRET  verify webhook signatures (optional)
 *   LLM_API_KEY       OpenAI-compatible key (optional — without it the agent
 *                     always hands off to a human)
 *   LLM_BASE_URL      default https://api.openai.com/v1
 *   LLM_MODEL         default gpt-4o-mini
 *   PORT              webhook receiver port (default 9798)
 *
 * Endpoints it serves:
 *   POST /webhook  — Janis outbound webhooks (message.user, takeover, etc.)
 *   POST /chat     — local test: {conversation_id, text} behaves like a channel
 *                    message (also usable as a direct non-Meta channel)
 *   GET  /health
 */
import { createServer } from 'node:http';
import { Janis } from '@janis/sdk';
import { verifySignature } from '@janis/sdk/webhook';
import type { AgentConfig, OutboundWebhook } from '@janis/shared';

const JANIS_API_KEY = process.env.JANIS_API_KEY ?? '';
const JANIS_BASE_URL = (process.env.JANIS_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.JANIS_WEBHOOK_SECRET ?? '';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const PORT = Number(process.env.PORT ?? 9798);

if (!JANIS_API_KEY) {
  console.error('Set JANIS_API_KEY — create an agent in Janis and copy its key.');
  process.exit(1);
}

const janis = new Janis({ apiKey: JANIS_API_KEY, baseUrl: JANIS_BASE_URL });

// --- runtime state ---------------------------------------------------------

let config: AgentConfig = {};
const paused = new Set<string>();
const histories = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

function historyFor(convId: string) {
  const h = histories.get(convId) ?? [];
  histories.set(convId, h);
  return h;
}

async function refreshConfig() {
  try {
    const res = await fetch(`${JANIS_BASE_URL}/v1/config`, {
      headers: { authorization: `Bearer ${JANIS_API_KEY}` },
    });
    if (res.ok) config = ((await res.json()) as { config: AgentConfig }).config ?? {};
  } catch {
    /* keep last-known config */
  }
}

function systemPrompt(): string {
  const parts = [
    config.system_prompt ??
      'You are a helpful customer support agent. Be concise and friendly. If you cannot help, say so clearly.',
  ];
  if (config.knowledge?.length) {
    parts.push(`\nKnowledge base:\n${config.knowledge.map((k) => `- ${k}`).join('\n')}`);
  }
  if (config.tone) parts.push(`\nTone: ${config.tone}.`);
  parts.push(
    '\nIf the user explicitly asks for a human, or you genuinely cannot resolve the issue, ' +
      'reply with exactly the token [HANDOFF] and nothing else.',
  );
  return parts.join('');
}

async function generate(convId: string, userText: string): Promise<string | null> {
  if (!LLM_API_KEY) return null;
  const history = historyFor(convId);
  history.push({ role: 'user', content: userText });
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 400,
      messages: [{ role: 'system', content: systemPrompt() }, ...history.slice(-20)],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim() ?? null;
  if (text) history.push({ role: 'assistant', content: text });
  return text;
}

/** Respond to an end-user message (from a hosted channel or /chat). */
async function handleUserMessage(convId: string, text: string, name?: string) {
  if (paused.has(convId)) return; // human owns it — enforced + local belt
  try {
    const reply = await generate(convId, text);
    if (!reply || reply.includes('[HANDOFF]')) {
      await janis.requestHuman(
        convId,
        !reply ? 'no LLM configured or empty reply' : 'agent signalled handoff',
      );
      return;
    }
    const r = await janis.agentMessage(convId, reply, { via: 'template' });
    if (r.results[0]?.paused) paused.add(convId);
  } catch (err) {
    await janis.failure(convId, err instanceof Error ? err.message : 'generation failed');
    await janis.requestHuman(convId, 'agent error — needs a human');
  }
  void name;
}

// --- webhook handling --------------------------------------------------------

async function handleWebhook(event: OutboundWebhook) {
  const convId = event.conversation_id;
  switch (event.type) {
    case 'message.user':
      await handleUserMessage(convId, event.text ?? '', event.user?.name);
      break;
    case 'human.takeover':
      paused.add(convId);
      console.log(`  takeover on ${convId} — pausing`);
      break;
    case 'human.resume':
      paused.delete(convId);
      histories.delete(convId); // fresh context after human session
      console.log(`  resumed on ${convId}`);
      break;
    case 'suggestion.request': {
      // draft a reply for the operator using our own model + transcript
      const transcript = (event.payload?.transcript as { direction: string; text: string }[]) ?? [];
      const lastUser = [...transcript].reverse().find((m) => m.direction === 'in');
      const draft = lastUser
        ? await generate(`${convId}:suggest`, lastUser.text ?? '')
        : await generate(`${convId}:suggest`, 'Draft a reply to this customer.');
      const text =
        draft && !draft.includes('[HANDOFF]')
          ? draft
          : 'I want to make sure we get this right — let me look into it and follow up shortly.';
      await fetch(`${JANIS_BASE_URL}/v1/suggestions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${JANIS_API_KEY}` },
        body: JSON.stringify({ conversation_id: convId, text }),
      });
      break;
    }
    case 'agent.send':
    case 'message.human':
      // Janis delivers these to hosted channels directly; nothing to do here
      break;
  }
}

// --- http server -------------------------------------------------------------

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

async function respond(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') return respond(res, 200, { ok: true });

  if (req.method === 'POST' && url === '/webhook') {
    const raw = await readBody(req);
    if (WEBHOOK_SECRET) {
      const sig = req.headers['x-janis-signature'] as string | undefined;
      if (!verifySignature(WEBHOOK_SECRET, sig, raw)) {
        return respond(res, 401, { error: 'invalid signature' });
      }
    }
    const event = JSON.parse(raw || '{}') as OutboundWebhook;
    console.log(`← webhook ${event.type} (${event.conversation_id})`);
    void handleWebhook(event).catch((e) => console.error('webhook handler error:', e));
    return respond(res, 200, { ok: true });
  }

  // local/manual channel: behaves like an inbound platform message
  if (req.method === 'POST' && url === '/chat') {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}') as {
      conversation_id?: string;
      text?: string;
      name?: string;
    };
    if (!body.conversation_id || !body.text) {
      return respond(res, 400, { error: 'conversation_id and text required' });
    }
    // record inbound + hand to the reply loop (mirrors the hosted-channel path)
    const r = await janis.userMessage(body.conversation_id, body.text, { name: body.name });
    if (!r.results[0]?.paused) {
      void handleUserMessage(body.conversation_id, body.text, body.name);
    }
    return respond(res, 200, { paused: r.results[0]?.paused ?? false });
  }

  return respond(res, 404, { error: 'not found' });
});

server.listen(PORT, async () => {
  await refreshConfig();
  setInterval(() => void refreshConfig(), 60_000); // pick up console edits
  console.log(`janis agent-template on :${PORT}`);
  console.log(`  config: ${JSON.stringify(config).slice(0, 120)}`);
  console.log(`  llm: ${LLM_API_KEY ? LLM_MODEL + ' @ ' + LLM_BASE_URL : 'DISABLED (hands off to humans)'}`);
  console.log(`  point this agent's webhook_url at http://localhost:${PORT}/webhook`);
});
