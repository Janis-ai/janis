import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, 'c06c742f-73d7-4445-84cc-853811b3654d'))
  .orderBy(desc(messages.createdAt)).limit(2);
for (const m of msgs) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  console.log(JSON.stringify(p.inspector ?? {}, null, 1).slice(0, 3000));
}
process.exit(0);
