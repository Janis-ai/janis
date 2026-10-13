import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
console.log('--- bindings for Shopify channel ---');
const b: any = await db.execute(sql`
  select cb.id, cb.platform_user_id, cb.conversation_id, c.state, c.external_id, c.created_at
  from channel_bindings cb join conversations c on c.id = cb.conversation_id
  where cb.channel_id = 'dd416836-710e-4be7-806e-b2196669e1c5'`);
for (const r of (b.rows ?? b)) console.log(r.platform_user_id, '→', String(r.conversation_id).slice(0,8), r.state, r.external_id, r.created_at);
console.log('--- all convs for agent ---');
const cv: any = await db.execute(sql`
  select id, state, external_id, created_at, last_message_at
  from conversations where agent_id = 'd408d7b5-fdad-49a4-a34d-11fa16e88135'
  order by created_at`);
for (const r of (cv.rows ?? cv)) console.log(String(r.id).slice(0,8), r.state, r.external_id, 'created', r.created_at);
process.exit(0);
