import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.direction, 'out')).orderBy(desc(messages.createdAt)).limit(3);
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  console.log('=== ', m.createdAt.toISOString().slice(11, 19), JSON.stringify(m.text ?? '').slice(0, 300));
  for (const w of p.widgets ?? []) {
    console.log(`  widget type=${w.type} items=${(w.items ?? []).length} total=${w.total} link_label=${w.items?.[0]?.link_label ?? w.link_label}`);
    for (const i of (w.items ?? []).slice(0, 12)) {
      console.log(`    - ${i.title} | ${i.price} | ${i.link_label ?? '?'} | stock=${i.stock} | cvid=${i.cart_variant_id ?? '-'} | src=${w.source ?? i.source ?? '?'}`);
    }
  }
}
