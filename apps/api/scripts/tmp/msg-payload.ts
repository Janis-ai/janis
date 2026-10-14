import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2]!)).orderBy(asc(messages.createdAt));
const n = Number(process.argv[3] ?? 6);
for (const m of rows.slice(-n)) {
  const p = (m.payload ?? {}) as any;
  console.log(`\n=== ${m.createdAt.toISOString().slice(11,19)} ${m.direction}: ${(m.text??'').slice(0,150)}`);
  if (p.inspector?.tools) console.log('TOOLS:', JSON.stringify(p.inspector.tools).slice(0,900));
  if (p.widgets) console.log('WIDGETS:', JSON.stringify(p.widgets).slice(0,1400));
}
process.exit(0);
