import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const [m] = await db.execute(sql`
  select m.payload->'inspector' as ins from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746'
    and m.created_at = '2026-10-12 12:57:48.433938+00'`);
const ins = (m as any).ins;
console.log('TOP KEYS', Object.keys(ins ?? {}));
for (const k of Object.keys(ins ?? {})) {
  const v = ins[k];
  console.log(k, '=', typeof v === 'object' ? JSON.stringify(v).slice(0, 400) : JSON.stringify(v));
}
process.exit(0);
