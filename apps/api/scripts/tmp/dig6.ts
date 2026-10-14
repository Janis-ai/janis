import { createDb } from '../../src/db/client.js';
import { messages, shopifyShops } from '../../src/db/schema.js';
import { gt, and, eq, asc } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:50:00Z')), eq(messages.direction, 'out')))
  .orderBy(asc(messages.createdAt));
for (const m of msgs) {
  if (!/13 products available|some of our products/i.test(m.text ?? '')) continue;
  const p = (m.payload as any) ?? {};
  console.log('===', (m.text ?? '').slice(0, 60));
  console.log('   tools:', (p.inspector?.tools ?? []).map((t:any)=>`${t.name}(${JSON.stringify(t.args)})`).join(' ; '));
}
// live page probe — identical q, fresh cursor
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const gql = async (after: string | null) => {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($q:String!,$after:String){products(first:12,query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{title}}}', variables: { q: ' status:active published_status:published', after } }),
  });
  return (await res.json()).data.products;
};
const p1 = await gql(null);
console.log('\np1 first/last:', p1.nodes[0].title, '|', p1.nodes.at(-1).title, '| hasNext:', p1.pageInfo.hasNextPage);
const p2 = await gql(p1.pageInfo.endCursor);
console.log('p2 nodes:', p2.nodes.map((n:any)=>n.title));
process.exit(0);
