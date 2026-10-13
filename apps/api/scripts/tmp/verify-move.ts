import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows: any = await db.execute(sql`
  select conversation_id, direction, created_at, left(text,60) as text from messages
  where conversation_id in ('26beb247-55b4-47f6-9be7-0aa4f58afb63','d9ef9b99-8afc-446f-a6b1-33d6413eae44')
  order by created_at`);
for (const r of (rows.rows ?? rows)) console.log(String(r.conversation_id).slice(0,8), r.direction, r.created_at, r.text);
process.exit(0);
