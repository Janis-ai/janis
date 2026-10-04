import { createDb } from '../../src/db/client.js';
import { channels, agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const chans = await db.select({ id: channels.id, name: channels.name, agentId: channels.agentId, creds: channels.credentials }).from(channels).where(eq(channels.kind, 'webchat'));
for (const c of chans) {
  const [a] = await db.select({ name: agents.name, ws: agents.workspaceId }).from(agents).where(eq(agents.id, c.agentId)).limit(1);
  console.log(c.id, '|', c.name, '| agent:', a?.name, '| internal:', Boolean((c.creds as {internal?:boolean})?.internal));
}
process.exit(0);
