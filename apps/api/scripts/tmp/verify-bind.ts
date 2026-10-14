import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, like, and } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
console.log('shop →', s.state, s.agentId);
for (const id of ['d408d7b5-fdad-49a4-a34d-11fa16e88135', '22f4cf25-bd8f-49d4-9f8e-a5a58a3ea3e4']) {
  const secs = await db.select({ name: schema.agentSecrets.name }).from(schema.agentSecrets).where(eq(schema.agentSecrets.agentId, id));
  const kfs = await db.select({ url: schema.knowledgeFiles.sourceUrl, status: schema.knowledgeFiles.status, len: schema.knowledgeFiles.sizeBytes })
    .from(schema.knowledgeFiles).where(and(eq(schema.knowledgeFiles.agentId, id), like(schema.knowledgeFiles.sourceUrl, 'shopify://%')));
  console.log(id.slice(0,8), '| secrets:', secs.map(s=>s.name).join(',') || 'none', '| kb:', kfs.map(k=>`${k.url}:${k.status}:${k.len}b`).join(' ') || 'none');
}
await sql.end();
