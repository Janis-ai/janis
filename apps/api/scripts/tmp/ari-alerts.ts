import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select a.created_at, a.type, a.status, left(a.detail,140) as detail
  from alerts a join conversations c on c.id = a.conversation_id
  join agents g on g.id = c.agent_id
  where g.workspace_id = '944d2822-c0e2-45f3-a484-2cbfd36fa8f9'
  order by a.created_at desc limit 25`);
console.log('ALERTS', JSON.stringify(rows, null, 1));
const msgs = await db.execute(sql`
  select count(*)::int as n, min(m.created_at) as first, max(m.created_at) as last
  from messages m join conversations c on c.id = m.conversation_id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62' and m.direction = 'in'`);
console.log('INBOUND', JSON.stringify(msgs));
process.exit(0);
