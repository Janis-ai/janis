import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const t = await db.execute(sql`
  select m.direction, m.text, m.created_at::text, c.external_id
  from messages m join conversations c on c.id = m.conversation_id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
    and (m.text ilike '%testing things out%' or m.text ilike '%test%')
  order by m.created_at desc limit 15`);
console.log('TESTING', JSON.stringify(t, null, 1));
const all = await db.execute(sql`
  select c.external_id, c.state,
    count(m.id)::int as msgs,
    count(*) filter (where m.direction='in') as inbound,
    min(m.created_at)::text as first, max(m.created_at)::text as last
  from conversations c left join messages m on m.conversation_id = c.id
  where c.agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
  group by c.id order by last desc nulls last limit 30`);
console.log('ALL', JSON.stringify(all));
process.exit(0);
