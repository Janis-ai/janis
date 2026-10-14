import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, like, and } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
// shop rows
for (const r of await db.select({
  shop: schema.shopifyShops.shop, state: schema.shopifyShops.state,
  agent: schema.shopifyShops.agentId, ws: schema.shopifyShops.workspaceId,
}).from(schema.shopifyShops)) console.log('shop:', r.shop, '|', r.state, '| agent:', r.agent, '| ws:', r.ws);
// shopify:// knowledge rows → which agents
const kfs = await db.select({ agent: schema.knowledgeFiles.agentId, url: schema.knowledgeFiles.sourceUrl, status: schema.knowledgeFiles.status })
  .from(schema.knowledgeFiles).where(like(schema.knowledgeFiles.sourceUrl, 'shopify://%'));
for (const k of kfs) console.log('kb:', k.url, '| agent:', k.agent, '|', k.status);
// agent names for those ids
const ids = [...new Set(kfs.map(k => k.agent))];
for (const id of ids) {
  const [a] = await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, id));
  console.log('agent', id, '=', a?.name);
}
await sql.end();
