import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(conversations).orderBy(desc(conversations.lastMessageAt)).limit(10);
for (const r of rows) console.log(r.lastMessageAt?.toISOString(), r.id, r.agentId.slice(0,8), r.lastMessageDirection, (r.lastMessagePreview ?? '').slice(0,50));
