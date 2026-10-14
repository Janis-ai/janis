import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';

const convId = process.argv[2];
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  const at = m.createdAt.toISOString().slice(11, 19);
  const w = (p.widgets ?? []).map((x: any) => `${x.type}(${(x.items ?? []).length} items)`).join(',');
  const qr = (p.quick_replies ?? []).map((q: any) => (typeof q === 'string' ? q : q.type)).join('|');
  const tools = (p.inspector?.tools ?? []).map((t: any) => `${t.name}${t.outcome ? ':' + t.outcome : ''}`).join(',');
  const firstItem = p.widgets?.[0]?.items?.[0];
  console.log(`${at} ${m.direction} ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 100)}`);
  if (w) console.log(`     widgets: ${w}`);
  if (firstItem) console.log(`     item0: ${JSON.stringify(firstItem).slice(0, 220)}`);
  if (qr) console.log(`     chips: ${qr}`);
  if (tools) console.log(`     tools: ${tools}`);
}
