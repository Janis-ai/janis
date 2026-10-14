import { createDb } from '../../src/db/client.js';
import { messages, agents } from '../../src/db/schema.js';
import { gt, and, eq, desc } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:35:00Z')), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt));
for (const m of msgs) {
  if (!/15 active|Hidden Snowboard|remaining products/i.test(m.text ?? '')) continue;
  const p = (m.payload as any) ?? {};
  console.log('===', (m.text ?? '').slice(0, 90));
  console.log('   tools:', (p.inspector?.tools ?? []).map((t:any)=>`${t.name}(${JSON.stringify(t.args)})→${t.outcome}`).join(' ; ') || 'none');
}
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tools = ((a.config as any)?.tools ?? []) as any[];
const t = tools.find((x) => x.name === 'shopify_search_products');
console.log('\nSTORED bodyTemplate:', JSON.stringify(t?.bodyTemplate ?? '').slice(0, 500));
console.log('params:', Object.keys(t?.params ?? {}));
console.log('availability:', JSON.stringify(t?.widget?.availability));
process.exit(0);
