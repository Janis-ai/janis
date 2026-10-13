import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  select count(*) filter (where image_url is not null)::int as with_img,
    count(*)::int as total
  from knowledge_files where agent_id = 'f454f596-338a-431f-b604-68535303317b'`);
console.log(JSON.stringify(r));
const sample = await db.execute(sql`
  select name, image_url from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b' and image_url is not null limit 3`);
console.log(JSON.stringify(sample, null, 1));
process.exit(0);
