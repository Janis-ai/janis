import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select name, image_url is not null as has_img, next_fetch_at
  from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b'
    and (name ilike '%moberly%' or name ilike '%walmer%' or name ilike '%summerhill%'
         or name ilike '%sumach%' or name ilike '%woodlawn%')
  order by name`);
console.log(rows);
const missing = await db.execute(sql`
  select name from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b' and image_url is null
  order by name`);
console.log('missing:', (missing as unknown as {name:string}[]).map(r => r.name).join(', '));
process.exit(0);
