// Phase 4 live setup for the already-bound dev shop — the embedded-load
// path would do this lazily, this just doesn't wait for an app open:
//   1. register the new webhook topics (orders/refunds/products)
//   2. create the shopify://catalog + shopify://policies knowledge rows
//   3. run the first sync of each so the agent knows the store today
// DATABASE_URL + JANIS_SECRETS_KEY from prod env.
import { createDb } from '../../src/db/client.js';
import { knowledgeFiles, shopifyShops } from '../../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { registerWebhooks } from '../../src/lib/shopifyApp.js';
import { ensureShopifyKnowledge } from '../../src/lib/shopifySync.js';
import { refreshKnowledgeSource } from '../../src/lib/urlSource.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops);
if (!row?.agentId || !row.workspaceId) throw new Error('shop not bound');

console.log('registering webhook topics…');
await registerWebhooks(row.shop, decryptSecret(row.accessTokenEnc!));
console.log('ensuring knowledge rows…');
await ensureShopifyKnowledge(db, row.agentId, row.workspaceId);

const files = await db
  .select()
  .from(knowledgeFiles)
  .where(and(eq(knowledgeFiles.agentId, row.agentId)));
for (const f of files.filter((f) => f.sourceUrl?.startsWith('shopify://'))) {
  const ok = await refreshKnowledgeSource(db, f);
  console.log(`${f.sourceUrl}: ${ok ? 'synced' : 'FAILED'}`);
}
const [cat] = await db
  .select({ text: knowledgeFiles.text })
  .from(knowledgeFiles)
  .where(and(eq(knowledgeFiles.agentId, row.agentId), eq(knowledgeFiles.sourceUrl, 'shopify://catalog')));
console.log('\n--- catalog head ---\n' + (cat?.text ?? '').split('\n').slice(0, 8).join('\n'));
const [pol] = await db
  .select({ text: knowledgeFiles.text })
  .from(knowledgeFiles)
  .where(and(eq(knowledgeFiles.agentId, row.agentId), eq(knowledgeFiles.sourceUrl, 'shopify://policies')));
console.log('\n--- policies head ---\n' + (pol?.text ?? '').split('\n').slice(0, 10).join('\n'));
process.exit(0);
