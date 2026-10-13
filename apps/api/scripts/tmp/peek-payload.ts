import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select m.id, m.created_at, m.payload
  from messages m
  join conversations c on c.id = m.conversation_id
  where c.agent_id = 'd408d7b5-fdad-49a4-a34d-11fa16e88135'
    and m.payload::text like '%widgets%'
  order by m.created_at desc limit 4`);
for (const r of (rows.rows ?? rows)) {
  const p = r.payload as any;
  console.log('===', r.id, r.created_at, 'keys:', Object.keys(p).join(','));
  (p.widgets ?? []).forEach((w: any, i: number) => {
    console.log(` widget[${i}] type=${w.type} items=${w.items?.length}`);
    (w.items ?? []).forEach((it: any) => console.log('   -', it.title, '|', it.price, '|', JSON.stringify(Object.keys(it))));
  });
}
process.exit(0);
