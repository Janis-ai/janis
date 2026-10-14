import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages).where(eq(messages.conversationId, '8aebeac6-701d-4b98-bd05-3017795adf2c')).orderBy(asc(messages.createdAt));
for (const m of msgs) console.log(m.createdAt.toISOString(), m.direction, (m.text ?? '').slice(0, 60));
process.exit(0);
