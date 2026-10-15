import { createDb } from '../../src/db/client.js';
import { workspaces } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [ws] = await db.select({ plan: workspaces.plan, name: workspaces.name, config: workspaces.config }).from(workspaces).where(eq(workspaces.id, 'acd296f3-0000-0000-0000-000000000000')).limit(1);
console.log(ws);
const all = await db.select({ id: workspaces.id, plan: workspaces.plan, name: workspaces.name }).from(workspaces);
for (const w of all) if (w.id.startsWith('acd296f3')) console.log('FOUND', w);
process.exit(0);
