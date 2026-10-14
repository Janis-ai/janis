// Clear the shop's stored offline token so the NEXT embedded app load
// re-exchanges it (prod ensureShopForSession only exchanges when no
// token is stored). Run this BEFORE the merchant opens the app: the
// scope-update consent completes before the iframe loads, so the session
// POST that follows picks up the newly-granted scopes in one step.
// The agent's mirrored SHOPIFY_TOKEN keeps working meanwhile — Shopify
// doesn't revoke the old token; only our row is cleared.
//   DATABASE_URL from env.
import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

const shop = process.argv[2] ?? 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();

const [before] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
console.log('before:', { state: before?.state, scopes: before?.scopes, hasToken: !!before?.accessTokenEnc });
if (!before?.accessTokenEnc) {
  console.log('nothing to clear');
  process.exit(0);
}
await db.update(shopifyShops).set({ accessTokenEnc: null }).where(eq(shopifyShops.id, before.id));
console.log('cleared — next embedded app load re-exchanges for a fresh-scope token');
process.exit(0);
