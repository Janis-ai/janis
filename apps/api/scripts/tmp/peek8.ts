import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select({ dir: messages.direction, text: messages.text, at: messages.createdAt, flags: messages.flags, payload: messages.payload })
  .from(messages)
  .where(eq(messages.conversationId, '1e070400-6dad-4895-b882-6e4d7e48ebb2'))
  .orderBy(asc(messages.createdAt));
for (const m of rows) {
  const w = (m.payload as any)?.widgets;
  const act = (m.payload as any)?.action;
  console.log(`--- ${m.dir} ${m.at.toISOString().slice(11, 19)}${m.flags ? ' flags:' + JSON.stringify(m.flags) : ''}`);
  if (m.text) console.log(m.text.slice(0, 500));
  if (act) console.log('ACTION:', JSON.stringify(act).slice(0, 300));
  if (w) console.log('WIDGETS:', JSON.stringify(w).slice(0, 400));
}
process.exit(0);
