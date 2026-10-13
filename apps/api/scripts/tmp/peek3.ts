import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select id, conversation_id, direction, created_at, left(text,80) as text, payload
  from messages
  where created_at > '2026-10-13 16:01:30+00' and created_at < '2026-10-13 16:03:00+00'
  order by created_at asc`);
for (const r of (rows.rows ?? rows)) {
  console.log(`${r.created_at} ${r.direction} conv=${String(r.conversation_id).slice(0,8)} "${r.text ?? ''}" payload=${JSON.stringify(r.payload).slice(0,300)}`);
}
process.exit(0);
