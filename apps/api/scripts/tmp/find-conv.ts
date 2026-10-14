import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(conversations).orderBy(desc(conversations.createdAt)).limit(6);
for (const c of rows) console.log(c.id, c.externalId, c.createdAt.toISOString());
process.exit(0);
