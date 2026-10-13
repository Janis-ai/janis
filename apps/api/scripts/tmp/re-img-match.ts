import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  select name, image_url from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b'
    and (name ilike '%98glencairnave%' or name ilike '%211walmerrd%')`);
console.log(r);
process.exit(0);
