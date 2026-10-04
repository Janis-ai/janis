import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { and, desc, eq, gt } from 'drizzle-orm';
const db = await createDb();
const CONV = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const ms = await db.select().from(messages)
  .where(and(eq(messages.conversationId, CONV), gt(messages.createdAt, new Date('2026-10-03T23:50:30Z'))))
  .orderBy(desc(messages.createdAt)).limit(20);
for (const m of ms.reverse()) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  console.log(m.createdAt.toISOString().slice(11, 19), m.direction.padEnd(3),
    (m.text ?? '').slice(0, 60).replace(/\n/g, ' '),
    p.via ? `via=${p.via}` : '', p.flags ? `flags=${JSON.stringify(p.flags)}` : '');
}
process.exit(0);
