import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
// stored image for davisville
const row = await db.execute(sql`
  select name, image_url from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b' and name ilike '%davisville%'`);
console.log('STORED:', row);
// latest card payload
const m = await db.execute(sql`
  select m.payload, m.created_at from messages m
  join conversations c on c.id = m.conversation_id
  where c.agent_id = 'f454f596-338a-431f-b604-68535303317b'
    and m.direction = 'out' and m.payload ? 'widgets'
  order by m.created_at desc limit 3`);
for (const r of m as any[]) {
  for (const w of r.payload?.widgets ?? []) if (w.type === 'cards')
    for (const i of w.items) console.log(r.created_at, '|', i.title, '|', i.image);
}
process.exit(0);
