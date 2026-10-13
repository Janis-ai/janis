import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
// u:<user> threads + cust_ threads on the test channel — state, counts, last dir
const convs = await db.execute(sql`
  select c.id, c.external_id, c.state, c.created_at::text as created,
    (select count(*)::int from messages m where m.conversation_id = c.id) as msgs,
    (select direction from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_dir
  from conversations c
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
  order by coalesce(c.last_message_at, c.created_at) desc
  limit 20`);
console.log('CONVS', JSON.stringify(convs, null, 1));
const alert = await db.execute(sql`
  select a.type, a.status, a.conversation_id, c.external_id, c.state, a.created_at::text
  from alerts a join conversations c on c.id = a.conversation_id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'`);
console.log('ALERTS', JSON.stringify(alert));
process.exit(0);
