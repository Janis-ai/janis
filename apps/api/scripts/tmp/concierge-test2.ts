import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { agents, channels, conversations, messages, users } from '../../src/db/schema.js';
import { and, asc, desc, eq } from 'drizzle-orm';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const RAIL = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, RAIL)).limit(1);
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const sig = createHmac('sha256', (ch.credentials as {identity_secret:string}).identity_secret).update(`${u.id}|${u.email}|${u.name ?? ''}`).digest('hex');
const claim = { id: u.id, name: u.name, email: u.email, sig };
const visitor = randomBytes(16).toString('hex');
const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId)).limit(1);
const [conv] = await db.select().from(conversations).where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, `webchat:u:${u.id}`))).limit(1);
console.log(`conv=${conv.id}`);

const PROBES = [
  { label: 'update_agent', text: 'Rename the Dickson Bonfield agent to "Dickson Bonfield Test".' },
  { label: 'create_agent', text: 'Create an agent named Smoke Test Bot in Michael\'s workspace — it answers smoke-test questions. Just propose it.' },
  { label: 'create_channel', text: 'Create a new webchat channel named "Test Widget" for the Smoke Test Bot agent — propose it.' },
  { label: 'update_channel', text: 'Rename the webchat channel "Test — Janis" to "Janis test rail" — propose it.' },
  { label: 'change_plan', text: 'Propose changing the janis workspace to the Starter plan.' },
  { label: 'teach_from_conv', text: 'Use teach_from_conversation to save a fact from this chat to the Janis agent.' },
  { label: 'refund_real', text: 'Propose a $1 refund for Stripe customer cus_VLnyb1eWAVc2iP.' },
  { label: 'sub_update', text: 'Propose updating the subscription for customer cus_VLnyb1eWAVc2iP to the Pro plan.' },
];

async function lastOut() {
  return (await db.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'out'))).orderBy(desc(messages.createdAt)).limit(1))[0];
}

for (const p of PROBES) {
  const prev = await lastOut();
  const res = await fetch(`${BASE}/chat/${RAIL}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitor, user: claim, text: p.text }),
  });
  if (!res.ok) { console.log(`[${p.label}] POST ${res.status}`); continue; }
  let msg; const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const cur = await lastOut();
    if (cur && cur.id !== prev?.id) { msg = cur; break; }
  }
  if (!msg) { console.log(`[${p.label}] TIMEOUT`); continue; }
  const pl = msg.payload as { inspector?: { tools?: {name:string;outcome:string}[] }; action?: {tool:string;status:string} ; widgets?: unknown[] };
  const tools = pl.inspector?.tools ?? [];
  // approval card may be a separate row — check next row too
  console.log(`[${p.label}] tools=${tools.map(t=>`${t.name}:${t.outcome}`).join(',') || '-'} action=${pl.action ? pl.action.tool + ':' + pl.action.status : '-'} | ${(msg.text ?? '').slice(0, 140).replace(/\n/g, ' ')}`);
}
process.exit(0);
