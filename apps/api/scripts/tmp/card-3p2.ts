import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r: any = await db.execute(sql`
  select payload from messages
  where conversation_id='3e5b0442-d624-41c5-a22f-a017e877cd67'
    and payload::text ilike '%3p%' order by created_at`);
for (const row of r.rows ?? r) {
  const p = row.payload;
  for (const w of p.widgets ?? []) {
    if (w.type !== 'cards') continue;
    for (const i of w.items ?? []) {
      if (/3p/i.test(String(i.title ?? ''))) console.log('ITEM', JSON.stringify(i));
    }
  }
  for (const tool of p.inspector?.tools ?? []) {
    console.log('TOOL', JSON.stringify(tool).slice(0, 2000));
  }
}
