import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { and, desc, eq, gt } from 'drizzle-orm';
const db = await createDb();
const CONV = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const ms = await db.select().from(messages)
  .where(and(eq(messages.conversationId, CONV), eq(messages.direction, 'out'), gt(messages.createdAt, new Date('2026-10-03T23:51:10Z'))))
  .orderBy(desc(messages.createdAt)).limit(8);
for (const m of ms.reverse()) {
  const p = (m.payload ?? {}) as { inspector?: unknown; via?: string };
  console.log('---', m.createdAt.toISOString().slice(11, 19), 'via=', p.via);
  console.log(JSON.stringify(p.inspector ?? null)?.slice(0, 900));
}
process.exit(0);
