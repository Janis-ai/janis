import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  select name, left(coalesce(error,''),80) as err from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b' and status = 'failed' limit 25`);
console.log(JSON.stringify(r, null, 1));
process.exit(0);
