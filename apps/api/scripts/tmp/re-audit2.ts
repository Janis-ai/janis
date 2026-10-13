import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const A = 'f454f596-338a-431f-b604-68535303317b';
const kn = await db.execute(sql`
  select name, source_url, status, size_bytes, refresh_hours, left(text, 400) as sample,
    length(text)::int as chars
  from knowledge_files where agent_id = ${A} order by created_at`);
console.log('KNOWLEDGE', JSON.stringify(kn, null, 1));
const convs = await db.execute(sql`
  select id, external_id, state, created_at::text, last_message_at::text
  from conversations where agent_id = ${A} order by coalesce(last_message_at, created_at) desc limit 10`);
console.log('CONVS', JSON.stringify(convs, null, 1));
process.exit(0);
