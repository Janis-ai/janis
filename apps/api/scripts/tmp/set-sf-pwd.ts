import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents } from '../../src/db/schema.js';
import { encryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const agentId = 'd408d7b5-fdad-49a4-a34d-11fa16e88135';
const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
if (!agent) throw new Error('agent not found');
const name = 'SHOPIFY_STOREFRONT_PASSWORD';
const enc = encryptSecret(process.env.SF_PWD!);
await db.insert(agentSecrets).values({ workspaceId: agent.workspaceId, agentId, name, valueEnc: enc })
  .onConflictDoUpdate({ target: [agentSecrets.agentId, agentSecrets.name], set: { valueEnc: enc } });
console.log('stored', name);
process.exit(0);
