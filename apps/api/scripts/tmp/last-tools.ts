import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, 'c06c742f-73d7-4445-84cc-853811b3654d'))
  .orderBy(desc(messages.createdAt)).limit(3);
for (const m of msgs) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const insp = (p.inspector ?? {}) as { tools?: { name:string; args?:unknown; result?:string }[] };
  for (const t of insp.tools ?? []) {
    console.log('=== tool:', t.name, 'args:', JSON.stringify(t.args));
    console.log('result:', String(t.result ?? '').slice(0, 1200), '\n');
  }
}
process.exit(0);
