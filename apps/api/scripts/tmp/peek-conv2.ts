import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { asc, eq } from 'drizzle-orm';

const db = await createDb();
const msgs = await db.select({
  direction: messages.direction, text: messages.text, payload: messages.payload, createdAt: messages.createdAt,
}).from(messages).where(eq(messages.conversationId, '8aebeac6-701d-4b98-bd05-3017795adf2c')).orderBy(asc(messages.createdAt));
for (const m of msgs) {
  const p = (m.payload ?? {}) as { calls?: { name: string; outcome: string; detail?: string }[]; internal?: boolean };
  console.log(`\n=== ${m.direction} @ ${m.createdAt.toISOString()}`);
  console.log(m.text.slice(0, 500));
  for (const c of p.calls ?? []) console.log(`  tool: ${c.name} → ${c.outcome}${c.detail ? ` (${c.detail.slice(0, 220)})` : ''}`);
}
process.exit(0);
