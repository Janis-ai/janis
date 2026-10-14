import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.lastMessageAt)).limit(5);
for (const c of rows) console.log(c.id, c.lastMessageAt?.toISOString(), c.externalId?.slice(0,50));
process.exit(0);
