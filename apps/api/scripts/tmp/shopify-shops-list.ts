import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db
  .select({
    shop: shopifyShops.shop,
    state: shopifyShops.state,
    agentId: shopifyShops.agentId,
    token: shopifyShops.accessTokenEnc,
    updatedAt: shopifyShops.updatedAt,
  })
  .from(shopifyShops);
for (const r of rows)
  console.log(r.shop, '|', r.state, '|', r.agentId ?? 'unlinked', '|', r.token ? 'has-token' : 'NO-TOKEN', '|', r.updatedAt);
process.exit(0);
