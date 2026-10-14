import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.direction, 'out')).orderBy(desc(messages.createdAt)).limit(2);
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  console.log('===', m.createdAt.toISOString().slice(11, 19));
  for (const t of p.inspector?.tools ?? []) {
    console.log(' tool:', t.name, 'args:', JSON.stringify(t.args));
    console.log('   keys:', Object.keys(t).join(','));
    console.log('   result:', JSON.stringify(t.result ?? t.outcome ?? t.error ?? '?').slice(0, 400));
  }
}
