import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const u = await db.execute(sql`
  select c.id, c.external_id, c.state, c.created_at::text as created,
    c.last_message_at::text as last_at,
    (select count(*)::int from messages m where m.conversation_id = c.id) as msgs,
    (select count(*)::int from messages m where m.conversation_id = c.id and m.direction='in') as inbound,
    (select direction from messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as last_dir
  from conversations c
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
    and c.external_id not like '%cust_%'
  order by coalesce(c.last_message_at, c.created_at) desc`);
console.log('U', JSON.stringify(u, null, 1));
const recent = await db.execute(sql`
  select m.direction, left(m.text, 90) as text, m.created_at::text,
    c.external_id
  from messages m join conversations c on c.id = m.conversation_id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
  order by m.created_at desc limit 14`);
console.log('RECENT', JSON.stringify(recent, null, 1));
process.exit(0);
