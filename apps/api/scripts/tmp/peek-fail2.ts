import { asc, desc, eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
const db = await createDb();
const convId = 'ac153999-5d34-4148-8776-6b98790800a4';
const [c] = await db.select().from(conversations).where(eq(conversations.id, convId));
console.log('conv:', c ? { agent: c.agentId, ext: c.externalId, state: c.state, up: JSON.stringify(c.userProfile).slice(0, 400) } : 'MISSING');
const msgs = await db.select({ dir: messages.direction, text: messages.text, payload: messages.payload, at: messages.createdAt })
  .from(messages).where(eq(messages.conversationId, convId)).orderBy(desc(messages.createdAt)).limit(10);
console.log('msg count fetched:', msgs.length);
for (const m of msgs.reverse()) {
  const p = m.payload as Record<string, unknown>;
  const ins = p?.inspector ? ` INSPECTOR:${JSON.stringify((p.inspector as { tools?: unknown }).tools ?? null)}` : '';
  console.log(`[${m.dir}] ${m.at?.toISOString()} ${(m.text ?? '').slice(0, 250)}${ins}`);
}
process.exit(0);
