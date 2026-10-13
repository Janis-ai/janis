import { createDb } from '../../src/db/client.js';
import { conversations, channelBindings } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select({
  id: conversations.id, state: conversations.state, isUnread: conversations.isUnread,
  ext: conversations.externalId, lastMessageAt: conversations.lastMessageAt,
  ch: channelBindings.channelId,
}).from(conversations)
  .leftJoin(channelBindings, eq(channelBindings.conversationId, conversations.id))
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.lastMessageAt)).limit(8);
for (const r of rows) console.log(r.state, 'unread:' + r.isUnread, r.lastMessageAt?.toISOString(), r.id.slice(0,8), r.ext?.slice(0,40), 'ch:' + (r.ch?.slice(0,8) ?? '-'));
process.exit(0);
