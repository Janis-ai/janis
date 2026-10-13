import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select m.id, m.direction, m.created_at, left(m.text, 120) as text,
         c.id as conv_id, c.state as conv_state
  from messages m
  join conversations c on c.id = m.conversation_id
  where c.agent_id = 'd408d7b5-fdad-49a4-a34d-11fa16e88135'
    and m.created_at > '2026-10-13 15:55:00+00'
  order by m.created_at asc limit 25`);
for (const r of (rows.rows ?? rows)) {
  console.log(`${r.created_at} ${r.direction} conv=${String(r.conv_id).slice(0,8)}(${r.conv_state}) ${r.text ?? ''}`);
}
process.exit(0);
