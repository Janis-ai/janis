import { createDb } from '../../src/db/client.js';
import { messages, knowledgeFiles, shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { gt, and, eq, desc, like } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:20:00Z')), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt));
for (const m of msgs) {
  if (!/hidden snowboard/i.test(m.text ?? '')) continue;
  const tools = ((m.payload as any)?.inspector?.tools ?? []);
  console.log('HIDDEN reply tools:', JSON.stringify(tools.map((t:any)=>({n:t.name,args:t.args,out:t.outcome}))));
}
const files = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
for (const f of files) {
  console.log('\nfile:', f.name, '|', f.status, '|', (f.content ?? '').length, 'chars');
  const i = (f.content ?? '').indexOf('Hidden Snowboard');
  if (i >= 0) console.log('  contains Hidden:', f.content!.slice(Math.max(0,i-50), i+150));
  const j = (f.content ?? '').indexOf('Minimal Snowboard');
  if (j >= 0) console.log('  contains Minimal:', f.content!.slice(Math.max(0,j-50), j+120));
}
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
for (const q of ['* status:active published_status:published', 'status:active published_status:published', '']) {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($q:String!){productsCount(query:$q){count}}', variables: { q } }),
  });
  console.log(`\nq="${q}" →`, JSON.stringify(await res.json()).slice(0, 200));
}
process.exit(0);
