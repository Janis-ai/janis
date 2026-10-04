import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { messages, conversations } from '../../src/db/schema.js';
const db = await createDb();
const convId = process.argv[2] ?? '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const [row] = await db
  .select({
    lastIn: sql<Date | null>`max(case when ${messages.direction} = 'in' then ${messages.createdAt} end)`,
    oldReply: sql<Date | null>`max(case when ${messages.direction} <> 'in' then ${messages.createdAt} end)`,
    newReply: sql<Date | null>`max(case when ${messages.direction} <> 'in' and coalesce(${messages.payload}->>'internal', 'false') <> 'true' then ${messages.createdAt} end)`,
  })
  .from(messages)
  .where(sql`${messages.conversationId} = ${convId}`);
const [conv] = await db
  .select({ state: conversations.state })
  .from(conversations)
  .where(sql`${conversations.id} = ${convId}`);
console.log(
  JSON.stringify({
    state: conv?.state,
    lastIn: row.lastIn,
    replyOldLogic: row.oldReply,
    replyNewLogic: row.newReply,
    pendingNow:
      !!row.lastIn && (!row.newReply || +new Date(row.lastIn) > +new Date(row.newReply)),
  }),
);
process.exit(0);
