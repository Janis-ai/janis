import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.execute(sql`
  select m.direction, m.text, m.payload, m.created_at::text
  from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746'
  order by m.created_at`);
for (const m of msgs as any[]) {
  const widgets = m.payload?.widgets ? ' [widgets:' + JSON.stringify(m.payload.widgets).slice(0,400) + ']' : '';
  const qr = m.payload?.quick_replies ? ' [qrs:' + JSON.stringify(m.payload.quick_replies) + ']' : '';
  console.log(`--- ${m.direction} ${m.created_at}${qr}${widgets}\n${(m.text||'').slice(0,900)}`);
}
process.exit(0);
