import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const tok = decryptSecret(row!.accessTokenEnc!);
const res = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'query{currentAppInstallation{accessScopes{handle}}}' }),
});
const d = (await res.json()) as { data?: { currentAppInstallation?: { accessScopes?: { handle: string }[] } } };
console.log((d.data?.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).join('\n'));
process.exit(0);
