import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  select id, kind, config->>'token' as token, config->>'visitor_id' as vid
  from channels where id = 'b88daf76-f197-4c48-9ed6-140992b478a6'`);
console.log(r);
process.exit(0);
