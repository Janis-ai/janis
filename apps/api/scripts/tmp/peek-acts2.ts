import { desc, eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { pendingActions } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db.select({ tool: pendingActions.toolName, status: pendingActions.status, args: pendingActions.args, at: pendingActions.createdAt })
  .from(pendingActions).where(eq(pendingActions.conversationId, 'ac153999-5d34-4148-8776-6b959799004a'))
  .orderBy(desc(pendingActions.createdAt)).limit(6);
for (const r of rows) console.log(r.at?.toISOString(), r.tool, r.status, JSON.stringify(r.args).slice(0, 250));
process.exit(0);
