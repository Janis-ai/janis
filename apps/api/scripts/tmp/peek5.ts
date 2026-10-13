import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select payload from messages
  where conversation_id = '26beb247-55b4-47f6-9be7-0aa4f58afb63'
    and direction = 'out' and payload::text like '%widgets%'
  order by created_at asc`);
for (const r of (rows.rows ?? rows)) {
  const p = r.payload as any;
  console.log(JSON.stringify(p, null, 1).slice(0, 3000));
  console.log('=====');
}
process.exit(0);
