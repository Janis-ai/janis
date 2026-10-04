import { createDb } from '../../src/db/client.js';
import { pendingActions } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const p = await db.select({ id: pendingActions.id, status: pendingActions.status, toolName: pendingActions.toolName, args: pendingActions.args }).from(pendingActions).where(eq(pendingActions.conversationId, '1fb291f8-c3f9-422d-bf3d-09766829efb6')).orderBy(desc(pendingActions.createdAt)).limit(15);
for (const a of p) console.log(a.id.slice(0,8), a.status.padEnd(9), a.toolName, JSON.stringify(a.args).slice(0,100));
process.exit(0);
