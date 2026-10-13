import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';

const db = await createDb();
const rows = await db.execute(sql`
  select key, count, reset_at from rate_limits
  where key like '%99c3ade8%' or key like 'chat%' order by reset_at desc limit 30`);
console.log(JSON.stringify(rows, null, 1));
process.exit(0);
