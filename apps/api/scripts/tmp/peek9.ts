import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select({ dir: messages.direction, text: messages.text, at: messages.createdAt, payload: messages.payload })
  .from(messages)
  .where(eq(messages.conversationId, '1e070400-6dad-4895-b882-6e4d7e48ebb2'))
  .orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = m.payload as any;
  if (p?.tool_calls || p?.inspector || p?.internal) {
    console.log(`--- ${m.dir} ${m.at.toISOString().slice(11, 19)}`);
    if (p.tool_calls) console.log('TOOLCALLS:', JSON.stringify(p.tool_calls).slice(0, 800));
    if (p.inspector) console.log('INSPECTOR:', JSON.stringify(p.inspector).slice(0, 800));
    if (p.internal) console.log('INTERNAL:', JSON.stringify(p.internal).slice(0, 400));
  }
}
process.exit(0);
