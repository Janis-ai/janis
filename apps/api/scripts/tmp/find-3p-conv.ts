import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, sql, eq, asc } from 'drizzle-orm';

const db = await createDb();
const hits = await db.execute(sql`
  select m.conversation_id, m.created_at, m.direction, left(m.text, 120) as text
  from messages m where m.text ilike '%3p fulfilled%' order by m.created_at desc limit 12`);
console.log((hits as any).rows ?? hits);
