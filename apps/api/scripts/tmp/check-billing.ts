import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [s] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com')).limit(1);
console.log(JSON.stringify(s.billing, null, 2));
console.log('updatedAt:', s.updatedAt);
process.exit(0);
