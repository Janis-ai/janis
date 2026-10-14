import { createDb } from '../../src/db/client.js';
import { channels } from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
const db = await createDb();
const chans = await db.select().from(channels).where(eq(channels.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
for (const ch of chans) {
  const c = ch.credentials as Record<string, unknown>;
  console.log(ch.id.slice(0,8), ch.kind, JSON.stringify(ch.name), 'internal:', (c as any).internal ?? false, 'accent:', (c.branding as any)?.accent ?? '—');
}
process.exit(0);
