import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { bindShop } from '../../src/lib/shopifyApp.js';
import { encryptSecret, decryptSecret } from '../../src/lib/secrets.js';

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema }) as never as import('../../src/db/client.js').Db;
const NEW = '22f4cf25-bd8f-49d4-9f8e-a5a58a3ea3e4';
const OLD = 'd408d7b5-fdad-49a4-a34d-11fa16e88135';
const WS = 'acd296f3-61e1-46c5-ae57-6cdbddbdca85';

const [row] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
if (!row) throw new Error('no shop row');
await bindShop(db, row, { workspaceId: WS, agentId: NEW });
console.log('rebound to torontofood agent');

// carry the storefront password to the new agent (recheck secret, not part of the mirror)
const [pw] = await db.select().from(schema.agentSecrets).where(and(
  eq(schema.agentSecrets.agentId, OLD), eq(schema.agentSecrets.name, 'SHOPIFY_STOREFRONT_PASSWORD')));
if (pw) {
  await db.insert(schema.agentSecrets).values({
    workspaceId: WS, agentId: NEW, name: 'SHOPIFY_STOREFRONT_PASSWORD', valueEnc: encryptSecret(decryptSecret(pw.valueEnc)),
  }).onConflictDoUpdate({
    target: [schema.agentSecrets.agentId, schema.agentSecrets.name],
    set: { valueEnc: pw.valueEnc, updatedAt: new Date() },
  });
  // old agent loses it too — it has no storefront to truth-check anymore
  await db.delete(schema.agentSecrets).where(and(
    eq(schema.agentSecrets.agentId, OLD), eq(schema.agentSecrets.name, 'SHOPIFY_STOREFRONT_PASSWORD')));
  console.log('password secret moved');
}
// force the new agent's shopify:// rows to fetch now
const kfs = await db.select().from(schema.knowledgeFiles)
  .where(and(eq(schema.knowledgeFiles.agentId, NEW), like(schema.knowledgeFiles.sourceUrl, 'shopify://%')));
const { refreshKnowledgeSource } = await import('../../src/lib/urlSource.js');
for (const kf of kfs) {
  const ok = await refreshKnowledgeSource(db, kf);
  console.log('refresh', kf.sourceUrl, '→', ok);
}
await sql.end();
