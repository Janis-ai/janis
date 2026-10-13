// One-off live cleanup after the ingress-fork fix:
//  1. refresh the bound agent's shopify tool defs (price map now currency-aware)
//  2. set the Shopify channel's visitor-facing title to the shop display name
//  3. move the two stray inbounds off the archived conv onto the bound fork
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { agents, channels, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TOOL_TEMPLATES } from '../../src/lib/toolTemplates.js';
import { decryptSecret } from '../../src/lib/secrets.js';

const db = await createDb();
const [shop] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
if (!shop?.agentId) throw new Error('no bound agent');

// 1. tool defs
const tpl = TOOL_TEMPLATES.find((t) => t.id === 'shopify')!;
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, shop.agentId));
const cfg = (a?.config ?? {}) as { tools?: Array<{ name?: string }> };
const names = new Set(tpl.tools.map((t) => t.name));
const tools = [
  ...(cfg.tools ?? []).filter((t) => !names.has(t.name ?? '')),
  ...tpl.tools.map((t) => ({ ...t, template: tpl.id })),
];
await db.update(agents).set({ config: { ...cfg, tools } }).where(eq(agents.id, shop.agentId));
console.log('refreshed', tpl.tools.length, 'tools');

// 2. channel title — fetch the shop display name
const token = shop.accessTokenEnc ? decryptSecret(shop.accessTokenEnc) : '';
let shopName = '';
if (token) {
  const res = await fetch(`https://${shop.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: '{shop{name}}' }),
  });
  const json = (await res.json()) as { data?: { shop?: { name?: string } } };
  shopName = json.data?.shop?.name ?? '';
}
console.log('shop name:', shopName);
const chans = await db.select().from(channels).where(eq(channels.agentId, shop.agentId));
for (const ch of chans) {
  const creds = (ch.credentials ?? {}) as Record<string, unknown>;
  if (ch.kind === 'webchat' && !creds.internal) {
    await db
      .update(channels)
      .set({ credentials: { ...creds, title: shopName || ch.name.replace(/^Shopify — /, '') } })
      .where(eq(channels.id, ch.id));
    console.log('set title on channel', ch.id);
  }
}

// 3. move the stray inbounds to the bound fork — find convs by externalId
const convs: any = await db.execute(sql`
  select id, external_id, state from conversations
  where agent_id = ${shop.agentId} and external_id like 'webchat:%' order by created_at`);
for (const c of (convs.rows ?? convs)) console.log('conv', c.id, c.state, c.external_id);
const fork = (convs.rows ?? convs).find((c: any) => String(c.external_id).includes('#'));
const archived = (convs.rows ?? convs).find((c: any) => !String(c.external_id).includes('#') && c.state === 'archived');
if (fork && archived) {
  const moved = await db.execute(sql`
    update messages set conversation_id = ${fork.id}
    where conversation_id = ${archived.id}
      and created_at > '2026-10-13 16:01:30+00'
      and payload->>'client_id' is not null`);
  console.log('moved rows:', JSON.stringify(moved).slice(0, 200));
}
process.exit(0);
