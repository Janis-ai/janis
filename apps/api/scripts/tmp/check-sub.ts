import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { shopifyGraphql } from '../../src/lib/shopifyApp.js';
import { adminToken } from '../../src/lib/shopifyToken.js';
const db = await createDb();
const [s] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com')).limit(1);
const token = await adminToken(db, s);
const res = await shopifyGraphql(s.shop, token, `{
  node(id: "gid://shopify/AppSubscription/75928469720") {
    ... on AppSubscription { id name status createdAt }
  }
  currentAppInstallation {
    app { id }
    allSubscriptions(first: 10) { nodes { id name status createdAt } }
  }
}`);
console.log(JSON.stringify(res, null, 2));
process.exit(0);
