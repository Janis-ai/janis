import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
process.env.SHOPIFY_BILLING_TEST = 'true';
const { startBillingSubscription } = await import('../../src/lib/shopifyApp.js');
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const { confirmationUrl } = await startBillingSubscription(db, row!, 'starter');
console.log('confirmationUrl:', confirmationUrl);
process.exit(0);
