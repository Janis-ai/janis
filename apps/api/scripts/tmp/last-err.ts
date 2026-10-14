import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const [m] = await db.select().from(messages).where(eq(messages.direction, 'out')).orderBy(desc(messages.createdAt)).limit(1);
const p = (m.payload ?? {}) as any;
for (const t of p.inspector?.tools ?? []) console.log(t.name, '|', JSON.stringify(t.error).slice(0, 600));
