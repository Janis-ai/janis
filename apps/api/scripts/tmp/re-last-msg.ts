import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const r = await db.execute(sql`
  select m.payload from messages m
  join conversations c on c.id = m.conversation_id
  where c.external_id like 'webchat:test:b88daf76-f197-4c48-9ed6-140992b478a6:%'
    and m.direction = 'out' and m.payload ? 'widgets'
  order by m.created_at desc limit 1`);
const p = (r as any)[0]?.payload;
for (const w of p?.widgets ?? []) if (w.type === 'cards') for (const i of w.items) console.log(i.title, '\n ', i.image);
process.exit(0);
