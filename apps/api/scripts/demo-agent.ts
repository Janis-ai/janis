/**
 * Demo agent — simulates an LLM support agent wired to Janis.
 *
 *   JANIS_API_KEY=jk_live_... npm run demo-agent -w apps/api
 *
 * It sends a fake conversation, occasionally fails / requests handoff,
 * and listens on :9797 for Janis takeover webhooks.
 */
import { createServer } from 'node:http';
import { Janis } from '@janis/sdk';

const API_KEY = process.env.JANIS_API_KEY ?? '';
const BASE_URL = process.env.JANIS_BASE_URL ?? 'http://localhost:8787';
const WEBHOOK_PORT = Number(process.env.DEMO_WEBHOOK_PORT ?? 9797);
const CONV_ID = `demo-${process.pid}`;

if (!API_KEY) {
  console.error('Set JANIS_API_KEY (printed by the API on first boot)');
  process.exit(1);
}

const janis = new Janis({ apiKey: API_KEY, baseUrl: BASE_URL });

// Receive human takeover events from Janis
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const event = JSON.parse(body || '{}');
    console.log(`\n← webhook ${event.type}: ${event.text ?? ''}`);
    if (event.type === 'human.takeover') console.log('  (agent paused for this conversation)');
    if (event.type === 'human.resume') console.log('  (agent resumed)');
    if (event.type === 'suggestion.request') {
      // a real agent would call its LLM here; we send a canned draft
      const text = "I can see the charge on INV-2049 — I'll refund it right away and email a confirmation. Anything else?";
      void fetch(`${BASE_URL}/v1/suggestions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ conversation_id: event.conversation_id, text }),
      }).then(() => console.log('  → posted suggestion back to Janis'));
    }
    res.writeHead(200).end('ok');
  });
}).listen(WEBHOOK_PORT, () => console.log(`webhook receiver on :${WEBHOOK_PORT}`));

const script = [
  ['Hi, I need help with my invoice', 'Sure — can you share the invoice number?'],
  ['It is INV-2049', 'Thanks! Pulling it up now.'],
  ['Actually this charge looks wrong', 'Let me check the line items…'],
] as const;

async function main() {
  console.log(`demo conversation: ${CONV_ID}`);
  for (const [user, agent] of script) {
    const r1 = await janis.userMessage(CONV_ID, user, { name: 'Demo User' });
    console.log(`→ user: "${user}"  (paused=${r1.results[0].paused})`);
    if (r1.results[0].paused) break;
    await sleep(800);
    const r2 = await janis.agentMessage(CONV_ID, agent);
    console.log(`→ agent: "${agent}" (paused=${r2.results[0].paused})`);
    if (r2.results[0].paused) break;
    await sleep(800);
  }

  // simulate a failure the agent can't handle → triggers handoff
  await janis.failure(CONV_ID, 'Could not verify billing account');
  await janis.requestHuman(CONV_ID, 'Billing dispute needs a human');
  console.log('→ failure + handoff requested. Waiting for operator… (Ctrl-C to quit)');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
void main();
