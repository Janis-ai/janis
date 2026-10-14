import { createDb } from '../../src/db/client.js';
import { agents, conversations, messages, shopifyShops } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops);
console.log('SHOP:', { state: shop.state, scopes: shop.scopes, hasToken: !!shop.accessTokenEnc });

const convs = await db.select().from(conversations).where(eq(conversations.agentId, shop.agentId!)).orderBy(desc(conversations.lastMessageAt)).limit(3);
for (const cv of convs) {
  console.log(`\n=== conv ${cv.id} state=${cv.state} last=${cv.lastMessageAt}`);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, cv.id)).orderBy(desc(messages.createdAt)).limit(6);
  for (const m of msgs.reverse()) {
    const p = (m.payload ?? {}) as Record<string, unknown>;
    console.log(`  [${m.direction}] ${String(m.text ?? '').slice(0, 90)}`);
    if (p.widgets) console.log('    widgets:', JSON.stringify(p.widgets).slice(0, 600));
    if (p.suggestions) console.log('    suggestions:', JSON.stringify(p.suggestions).slice(0, 300));
  }
}
process.exit(0);
