import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const rows = await db.execute(sql`
  select c.id, c.external_id, c.created_at::text from conversations c
  where c.external_id like '%verify-%' order by c.created_at desc limit 3`);
console.log(rows);
const msgs = await db.execute(sql`
  select m.direction, m.text, m.payload, m.created_at::text from messages m
  join conversations c on c.id = m.conversation_id
  where c.external_id like '%verify-%' order by m.created_at`);
for (const m of msgs as any[]) {
  console.log(`--- ${m.direction} ${m.created_at}\n${(m.text||'').slice(0,400)}`);
  if (m.payload?.widgets) for (const w of m.payload.widgets) {
    console.log('widget:', w.type);
    if (w.type === 'cards') for (const it of w.items) console.log('  card:', it.title, '| link:', it.link, '\n    img:', it.image);
  }
  if (m.payload?.quick_replies) console.log('QRs:', JSON.stringify(m.payload.quick_replies));
}
process.exit(0);
