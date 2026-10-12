import { desc, sql } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db.execute(sql`select id, agent_id, state, last_message_at from conversations where id::text like 'ac153999%'`);
console.log(JSON.stringify(rows, null, 1));
const recent = await db.select({ id: conversations.id, agent: conversations.agentId, at: conversations.lastMessageAt })
  .from(conversations).orderBy(desc(conversations.lastMessageAt)).limit(8);
for (const r of recent) console.log(r.id, r.agent, r.at?.toISOString());
process.exit(0);
