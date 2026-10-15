import { createDb } from '../../src/db/client.js';
import { shopifyShops, conversations, messages, agents } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp.myshopify.com'));
if (!shop) { console.log('no blamp row'); process.exit(0); }
console.log('shop row:', shop.id, shop.state, shop.agentId);

const convs = await db.select().from(conversations).where(eq(conversations.workspaceId, shop.workspaceId!)).orderBy(desc(conversations.updatedAt)).limit(3);
for (const c of convs) {
  const msgs = await db.select({ direction: messages.direction, text: messages.text, payload: messages.payload, createdAt: messages.createdAt }).from(messages).where(eq(messages.conversationId, c.id)).orderBy(messages.createdAt).limit(30);
  console.log('\n=== conv', c.id, c.channelName ?? '');
  for (const m of msgs) console.log(`[${m.direction}] ${m.createdAt.toISOString().slice(11,19)}`, (m.text ?? '').slice(0, 200), m.payload ? JSON.stringify(m.payload).slice(0,300) : '');
}
process.exit(0);
