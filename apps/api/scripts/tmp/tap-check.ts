import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(gt(messages.createdAt, new Date(Date.now() - 20 * 60_000))).orderBy(asc(messages.createdAt));
for (const m of rows) console.log(m.createdAt.toISOString().slice(11,19), m.direction, JSON.stringify((m.text ?? '').slice(0, 90)));
