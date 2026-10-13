import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select m.payload->>'client_id' as cid, m.created_at::text, left(m.text,40) as text,
    right(c.external_id, 12) as conv
  from messages m join conversations c on c.id = m.conversation_id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62' and m.direction = 'in'
  order by m.created_at`);
console.log(JSON.stringify(rows, null, 0));
process.exit(0);
