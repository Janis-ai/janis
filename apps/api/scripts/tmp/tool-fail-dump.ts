import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2]!)).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const tools = ((m.payload as any)?.inspector?.tools ?? []) as any[];
  for (const t of tools) {
    if (/list_collections|sales_stats/.test(t.name ?? '') || t.outcome === 'failed') {
      console.log('CALL', t.name, '| outcome:', t.outcome, '| args:', JSON.stringify(t.args ?? {}));
      console.log('  result:', String(t.result ?? t.error ?? '').slice(0, 400));
    }
  }
}
process.exit(0);
