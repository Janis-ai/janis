import { desc, eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
const db = await createDb();
const convId = 'ac153999-5d34-4148-8776-6b959799004a';
const [c] = await db.select().from(conversations).where(eq(conversations.id, convId));
console.log('profile:', JSON.stringify(c?.userProfile).slice(0, 700));
const msgs = await db.select({ dir: messages.direction, text: messages.text, payload: messages.payload, at: messages.createdAt })
  .from(messages).where(eq(messages.conversationId, convId)).orderBy(desc(messages.createdAt)).limit(12);
for (const m of msgs.reverse()) {
  const p = m.payload as Record<string, unknown>;
  const ins = p?.inspector ? ` | TOOLS:${JSON.stringify((p.inspector as { tools?: unknown }).tools)}` : '';
  const ev = p?.event ? ` | EVENT:${JSON.stringify(p).slice(0, 400)}` : '';
  console.log(`\n[${m.dir}] ${m.at?.toISOString()}\n${(m.text ?? '').slice(0, 400)}${ins}${ev}`);
}
process.exit(0);
