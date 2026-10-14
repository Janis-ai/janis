import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const res = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': decryptSecret(row!.accessTokenEnc!) },
  body: JSON.stringify({ query: '{webhookSubscriptions(first:25){nodes{topic endpoint{__typename ... on WebhookHttpEndpoint{callbackUrl}}}}}' }),
});
const nodes = (await res.json()).data.webhookSubscriptions.nodes;
for (const n of nodes) console.log(n.topic, '→', n.endpoint?.callbackUrl);
process.exit(0);
