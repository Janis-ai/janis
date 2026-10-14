import { createDb } from '../../src/db/client.js';
import { channels } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, 'dd416836-710e-4be7-806e-b2196669e1c5'));
console.log('id:', ch!.id);
console.log('slug/token fields:', JSON.stringify(Object.keys(ch!)), '| external_id:', ch!.externalId);
const c = ch!.credentials as Record<string, unknown>;
console.log('cred keys:', Object.keys(c));
// what does webchat.ts key channels by?
process.exit(0);
