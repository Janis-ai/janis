import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  update knowledge_files set status = 'ready', error = null
  where agent_id = 'f454f596-338a-431f-b604-68535303317b' and status = 'failed'
    and error like 'fetch failed: HTTP 429'
  returning id`);
console.log('restored', r.length, 'rows');
process.exit(0);
