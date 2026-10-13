import { createDb } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [c] = await db.select({
  id: conversations.id, state: conversations.state, isUnread: conversations.isUnread,
  snoozedUntil: conversations.snoozedUntil, lastMessageAt: conversations.lastMessageAt,
}).from(conversations).where(eq(conversations.id, '26beb247-55b4-47f6-9be7-0aa4f58afb63'));
console.log(c);
process.exit(0);
