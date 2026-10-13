import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const [m] = await db.execute(sql`
  select m.payload->'inspector' as ins from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746'
    and m.created_at = '2026-10-12 12:33:18.436437+00'`);
console.log(JSON.stringify(m, null, 1).slice(0, 4000));
process.exit(0);
