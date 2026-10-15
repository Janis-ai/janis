import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';

const SHOP = 'blamp-vzfzgclz.myshopify.com';
const VARIANT_ID = '52686507966680';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const token = secrets.SHOPIFY_TOKEN;

const gql = await fetch(`https://${SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ query: `{ productVariant(id:"gid://shopify/ProductVariant/${VARIANT_ID}") { id title availableForSale inventoryQuantity inventoryPolicy sellableOnlineQuantity inventoryItem { tracked } } }` }),
}).then(r => r.json());
console.log('ADMIN VARIANT:', JSON.stringify(gql.data ?? gql, null, 2));

const sfRes = await fetch(`https://${SHOP}/products/the-3p-fulfilled-snowboard.js`);
console.log('SF product status:', sfRes.status, sfRes.headers.get('content-type'));
const sfText = await sfRes.text();
if (sfRes.headers.get('content-type')?.includes('json')) {
  const sf = JSON.parse(sfText);
  for (const v of sf.variants ?? []) {
    console.log(`SF variant ${v.id} "${v.title}" available=${v.available} inv_qty=${v.inventory_quantity} inv_policy=${v.inventory_policy} inv_mgmt=${v.inventory_management}`);
  }
} else console.log('SF body head:', sfText.slice(0, 200));

const add = await fetch(`https://${SHOP}/cart/add.js`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ items: [{ id: Number(VARIANT_ID), quantity: 1 }] }),
});
console.log('ADD status:', add.status);
console.log('ADD body:', (await add.text()).slice(0, 600));
process.exit(0);
