import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.direction, 'out')).orderBy(desc(messages.createdAt)).limit(4);
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  console.log('===', m.createdAt.toISOString().slice(11, 19));
  console.log('text:', JSON.stringify((m.text ?? '').slice(0, 200)));
  console.log('inspector.tools:', JSON.stringify((p.inspector?.tools ?? []).map((t: any) => ({ n: t.name, a: t.args })).slice(0, 4)));
  console.log('widget sources:', JSON.stringify((p.widgets ?? []).map((w: any) => ({ t: w.type, n: (w.items ?? []).length, src: w.source }))));
}
