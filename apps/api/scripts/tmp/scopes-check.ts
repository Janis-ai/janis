import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
const db = await createDb();
const [r] = await db.select({ scopes: shopifyShops.scopes, shop: shopifyShops.shop, hasToken: shopifyShops.accessTokenEnc }).from(shopifyShops);
console.log(r.shop, '→', r.scopes, '| token:', r.hasToken ? 'yes' : 'no');
process.exit(0);
