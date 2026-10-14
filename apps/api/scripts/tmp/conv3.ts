import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages)
  .where(and(eq(messages.conversationId, '8aebeac6-701d-4b98-bd05-3017795adf2c'), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt)).limit(4);
for (const m of rows) {
  console.log('===', m.createdAt?.toISOString(), (m.text ?? '').slice(0, 70));
  const widgets = (m.payload as any)?.widgets ?? [];
  for (const w of widgets) {
    console.log('  widget:', w.type, 'items:', w.items?.length);
    for (const it of (w.items ?? []).slice(0, 6)) {
      console.log('    -', JSON.stringify(it.title), '| image:', JSON.stringify((it.image ?? '').slice(0, 90)) || 'EMPTY');
    }
  }
}
process.exit(0);
