import { createDb } from '../../src/db/client.js';
import { messages, shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq, and } from 'drizzle-orm';
const db = await createDb();
// card item for Hidden Snowboard
const rows = await db.select().from(messages)
  .where(and(eq(messages.conversationId, 'e276eb52-f3a0-4f0b-bcc2-142f53ea64a4'), eq(messages.direction, 'out')));
for (const m of rows) {
  for (const w of (((m.payload as any)?.widgets) ?? [])) {
    for (const it of (w.items ?? [])) {
      if (it.title?.includes('Hidden')) console.log('CARD ITEM:', JSON.stringify(it));
    }
  }
}
// real product state
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{ products(first: 2, query: "title:*Hidden*") { nodes { id title status variants(first: 3) { nodes { id availableForSale inventoryQuantity sellableOnlineQuantity requiresSellingPlan } } } } }` }),
});
console.log(JSON.stringify((await res.json()).data, null, 2));
process.exit(0);
