import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select m.id, m.direction, m.created_at, left(m.text, 200) as text, m.payload
  from messages m
  join conversations c on c.id = m.conversation_id
  where c.agent_id = 'd408d7b5-fdad-49a4-a34d-11fa16e88135'
  order by m.created_at desc limit 14`);
for (const r of [...(rows.rows ?? rows)].reverse()) {
  const p = r.payload as any;
  console.log(`--- ${r.direction} ${r.created_at}`);
  console.log(String(r.text ?? '').slice(0, 200));
  if (p?.widgets) console.log('WIDGETS:', JSON.stringify(p.widgets).slice(0, 1600));
  if (p?.toolCalls) console.log('TOOLS:', JSON.stringify(p.toolCalls).slice(0, 600));
}
process.exit(0);
