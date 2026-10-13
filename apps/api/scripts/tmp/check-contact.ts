import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(sql, { schema });

const convId = '6d498438-20ed-4e92-8ca1-4af1b553eab3';
const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, convId));
if (!conv) { console.log('conversation not found'); process.exit(0); }
console.log('conv:', {
  id: conv.id, externalId: conv.externalId, state: conv.state,
  contactId: conv.contactId, userProfile: conv.userProfile,
  createdAt: conv.createdAt,
});
if (conv.contactId) {
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId));
  console.log('contact:', c);
}
// last few messages to see whether save_user_profile ran
const msgs = await db.select().from(schema.messages)
  .where(eq(schema.messages.conversationId, convId))
  .orderBy(schema.messages.createdAt);
for (const m of msgs.slice(-12)) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  console.log(`[${m.direction}] ${m.text?.slice(0, 140)}`, p.tools ? `tools=${JSON.stringify(p.tools)}` : '');
}
await sql.end();
