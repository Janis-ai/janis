import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const conv = process.argv[2];
const rows = await db.select().from(messages).where(eq(messages.conversationId, conv)).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  for (const t of p.inspector?.tools ?? []) {
    const out = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? t.result ?? t.raw ?? '');
    console.log('===', m.createdAt.toISOString().slice(11,19), t.name, 'args:', JSON.stringify(t.args));
    console.log('keys:', Object.keys(t));
    console.log(out.slice(0, 4000));
    console.log('...len', out.length);
  }
}
process.exit(0);
