import { createDb } from '../../src/db/client.js';
import { pendingActions } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(pendingActions)
  .where(eq(pendingActions.conversationId, '26beb247-55b4-47f6-9be7-0aa4f58afb63'))
  .orderBy(desc(pendingActions.createdAt)).limit(5);
for (const a of rows) console.log(a.id, a.tool, a.status, a.workspaceId, a.createdAt);
process.exit(0);
