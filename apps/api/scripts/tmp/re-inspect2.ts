import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.execute(sql`
  select m.created_at::text, m.payload->'inspector' as ins
  from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746' and m.direction = 'out'
  order by m.created_at`);
for (const m of msgs as any[]) {
  if (!m.ins) continue;
  const i = m.ins;
  console.log('===', m.created_at);
  console.log('  model:', i.model, '| knowledge:', JSON.stringify(i.knowledge ?? i.sources ?? i.docs ?? null));
  if (i.notes) console.log('  notes:', JSON.stringify(i.notes).slice(0,300));
}
process.exit(0);
