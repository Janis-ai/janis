// Introspect payload shapes for the phase-2 GraphQL tools.
import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';

const db = await createDb();
const [row] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(row!.accessTokenEnc!);

const q = `{
  a: __type(name: "OrderCancelPayload") { fields { name type { name kind ofType { name } } } }
  b: __type(name: "DraftOrderCreatePayload") { fields { name type { name kind ofType { name } } } }
  c: __type(name: "OrderUpdatePayload") { fields { name type { name kind ofType { name } } } }
  d: __type(name: "OrderCancelReason") { enumValues { name } }
  e: __type(name: "DraftOrderInput") { inputFields { name type { name kind ofType { name kind ofType { name } } } } }
}`;
const res = await fetch('https://janis-store-sx5bpcd3.myshopify.com/admin/api/2026-10/graphql.json', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: q }),
});
const data = await res.json();
for (const [k, v] of Object.entries<any>(data.data)) {
  console.log('===', k);
  for (const f of v.fields ?? v.enumValues ?? v.inputFields ?? []) console.log('  ', f.name);
}
process.exit(0);
