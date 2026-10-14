import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages)
  .where(eq(messages.conversationId, '0e19e4aa-69aa-42ff-a17c-328403bbc145'))
  .orderBy(asc(messages.createdAt));
for (const m of rows.slice(-14)) {
  const ws = (m.payload as any)?.widgets;
  if (!ws?.length) continue;
  console.log('===', m.createdAt?.toISOString(), JSON.stringify((m.text ?? '').slice(0,80)));
  for (const w of ws) console.log(JSON.stringify(w).slice(0, 1600));
}
process.exit(0);
