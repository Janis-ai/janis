import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, and, eq, desc } from 'drizzle-orm';
const db = await createDb();
const [m] = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:20:00Z')), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt)).limit(30)
  .then((r) => r.filter((x) => /15 active/.test(x.text ?? '')));
const p = (m!.payload ?? {}) as Record<string, unknown>;
console.log('payload keys:', Object.keys(p));
console.log(JSON.stringify(p.inspector, null, 2).slice(0, 4000));
process.exit(0);
