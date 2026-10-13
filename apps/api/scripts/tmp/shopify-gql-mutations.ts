// Syntax-check the three mutation documents against the live schema by
// sending them with empty variables — a well-formed document errors on the
// missing $var, a malformed one errors on parse/unknown-field.
import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { TOOL_TEMPLATES } from '../../src/lib/toolTemplates.js';
import type { ToolDef } from '../../src/lib/toolExec.js';

const db = await createDb();
const [row] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db
  .select()
  .from(agentSecrets)
  .where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);

const tools = TOOL_TEMPLATES.find((t) => t.id === 'shopify')!.tools as ToolDef[];
for (const name of [
  'shopify_cancel_order',
  'shopify_create_draft_order',
  'shopify_update_shipping_address',
  'shopify_update_order_tags',
]) {
  const tool = tools.find((t) => t.name === name)!;
  const m = tool.bodyTemplate!.match(/"query":"((?:[^"\\]|\\.)*)"/);
  const doc = { query: JSON.parse(`"${m![1]}"`) as string };
  const res = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': secrets.SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query: doc.query, variables: {} }),
  });
  const body = (await res.json()) as { errors?: { message: string }[] };
  console.log(name, '→', JSON.stringify(body.errors?.map((e) => e.message) ?? body).slice(0, 300));
}
process.exit(0);
