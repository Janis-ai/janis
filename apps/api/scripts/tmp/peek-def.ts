import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tools = (a!.config as any).tools as any[];
const t = tools.find((x) => x.name === 'shopify_search_products')!;
console.log('bodyTemplate:', t.bodyTemplate);
process.exit(0);
