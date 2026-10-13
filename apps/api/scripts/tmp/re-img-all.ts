import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select name, source_url, image_url from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b'
    and (name ilike '%ivy%' or name ilike '%davisville%' or name ilike '%glencairn%')`);
console.log(rows);
process.exit(0);
