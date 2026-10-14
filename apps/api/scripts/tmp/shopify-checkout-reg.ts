// Register CHECKOUTS_UPDATE on the bound dev shop — registerWebhooks
// re-POSTs every topic idempotently, then lists what landed.
import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { registerWebhooks } from '../../src/lib/shopifyApp.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops);
if (!row) throw new Error('no shop');
const tok = decryptSecret(row.accessTokenEnc!);
await registerWebhooks(row.shop, tok);
const res = await fetch(`https://${row.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({
    query:
      'query{webhookSubscriptions(first:30){nodes{topic endpoint{__typename ... on WebhookHttpEndpoint{callbackUrl}}}}}',
  }),
});
const data = (await res.json()) as {
  data?: { webhookSubscriptions?: { nodes?: { topic: string; endpoint: { callbackUrl?: string } }[] } };
};
for (const n of data.data?.webhookSubscriptions?.nodes ?? [])
  console.log(`${n.topic} -> ${n.endpoint.callbackUrl}`);
process.exit(0);
