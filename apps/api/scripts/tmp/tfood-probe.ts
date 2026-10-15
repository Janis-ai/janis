import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';
import { shopifyGraphql } from '../../src/lib/shopifyApp.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'torontofood.myshopify.com')).limit(1);
const token = await adminToken(db, row);
const r = await shopifyGraphql(row.shop, token, `{
  productsCount { count }
  products(first: 5) { nodes { title status featuredImage { url } onlineStoreUrl } }
  shop { name ianaTimezone }
}`);
console.log(JSON.stringify(r.data ?? r, null, 2).slice(0, 2500));
