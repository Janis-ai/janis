import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2]!)).orderBy(asc(messages.createdAt));
for (const m of rows.slice(-4)) {
  const p = (m.payload ?? {}) as any;
  console.log(`\n=== ${m.createdAt.toISOString().slice(11,19)} ${m.direction}: ${(m.text??'').slice(0,80)}`);
  if (p.inspector) console.log('INSPECTOR:', JSON.stringify(p.inspector).slice(0, 1500));
  if (p.link_guard) console.log('LINKGUARD:', JSON.stringify(p.link_guard));
}
process.exit(0);
