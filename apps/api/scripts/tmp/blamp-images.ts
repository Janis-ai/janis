import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';
import { shopifyGraphql } from '../../src/lib/shopifyApp.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com')).limit(1);
const token = await adminToken(db, row);
const r = await shopifyGraphql(row.shop, token, `{
  products(first: 12, query: "status:active") { nodes { title featuredImage { url } } }
}`);
for (const n of (r.data as {products:{nodes:{title:string;featuredImage:{url:string}|null}[]}}).products.nodes)
  console.log(n.title, '|', n.featuredImage?.url ?? 'no image');
process.exit(0);
