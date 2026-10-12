import { asc, eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
const db = await createDb();
const convId = 'ac153999-5d34-4148-8776-6b98790800a4';
const [c] = await db.select({ up: conversations.userProfile }).from(conversations).where(eq(conversations.id, convId));
console.log('metadata:', JSON.stringify((c?.up as any)?.metadata ?? {}, null, 1));
const msgs = await db.select({ dir: messages.direction, text: messages.text, payload: messages.payload, at: messages.createdAt })
  .from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt));
for (const m of msgs.slice(-10)) {
  const p = m.payload as Record<string, unknown>;
  const ins = p?.inspector ? `\n  INSPECTOR: ${JSON.stringify((p.inspector as any).tools ?? p.inspector).slice(0, 800)}` : '';
  const flag = p?.event ? ` | event:${p.event}` : '';
  console.log(`\n[${m.dir}] ${m.at?.toISOString()}${flag}\n${(m.text ?? '').slice(0, 300)}${ins}`);
}
process.exit(0);
