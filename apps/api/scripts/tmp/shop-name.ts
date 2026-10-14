import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
console.log(row!.shop);
process.exit(0);
