import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r: any = await db.execute(sql`
  select payload from messages
  where conversation_id='3e5b0442-d624-41c5-a22f-a017e877cd67'
    and payload->'widgets' is not null order by created_at desc limit 1`);
for (const row of r.rows ?? r) {
  for (const w of row.payload.widgets) {
    if (w.type !== 'cards') continue;
    for (const i of w.items) {
      if (/3p/i.test(i.title ?? '')) console.log(JSON.stringify(i, null, 2));
    }
  }
}
// also the inspector tool output for the search
const t: any = await db.execute(sql`
  select payload from messages
  where conversation_id='3e5b0442-d624-41c5-a22f-a017e877cd67'
    and payload->'inspector'->'tools' is not null order by created_at asc`);
for (const row of t.rows ?? t) {
  for (const tool of row.payload.inspector.tools) {
    const out = JSON.stringify(tool);
    if (/3p/i.test(out)) console.log('TOOL:', out.slice(0, 3000));
  }
}
