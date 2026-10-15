import { createDb } from '../../src/db/client.js';
import { shopifyShops, conversations, messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com'));
console.log('ws:', shop.workspaceId, 'agent:', shop.agentId);
const convs = await db.select().from(conversations).where(eq(conversations.agentId, shop.agentId!)).orderBy(desc(conversations.lastMessageAt)).limit(2);
for (const c of convs) {
  console.log('\n=== conv', c.id, c.lastMessageAt?.toISOString());
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(messages.createdAt);
  for (const m of msgs) {
    const p = (m.payload ?? {}) as any;
    const tools = (p.inspector?.tools ?? []).map((t: any) => `${t.name}:${JSON.stringify(t.args ?? {}).slice(0,140)} → ${JSON.stringify(t.result ?? t.error ?? '').slice(0,160)}`).join('\n       ');
    console.log(`[${m.direction}] ${m.createdAt.toISOString().slice(11,19)} ${(m.text ?? '').replace(/\n/g,' ').slice(0,150)}`);
    if (tools) console.log('   tools:', tools);
    const w = (p.widgets ?? []).map((x: any) => `${x.type} ${JSON.stringify((x.items??[])[0] ?? {}).slice(0,220)}`);
    if (w.length) console.log('   widgets:', w.join(' | '));
  }
}
process.exit(0);
