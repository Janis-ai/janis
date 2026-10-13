import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.execute(sql`
  select m.created_at::text, m.payload
  from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746' and m.direction = 'out'
  order by m.created_at`);
for (const m of msgs as any[]) {
  const p = m.payload ?? {};
  const keys = Object.keys(p).filter(k => k !== 'quick_replies' && k !== 'widgets');
  console.log(m.created_at, 'keys:', JSON.stringify(p.run ?? p.sources ?? p.knowledge ?? keys));
}
process.exit(0);
