import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sessions, users } from '../../src/db/schema.js';
import { sha256 } from '../../src/lib/crypto.js';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
const db = await createDb();
const [mike] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
if (!mike) throw new Error('no mike');
const token = randomBytes(32).toString('hex');
await db.insert(sessions).values({
  id: sha256(token), userId: mike.id,
  workspaceId: 'acd296f3-61e1-46c5-ae57-6cdbddbdca85',
  expiresAt: new Date(Date.now() + 3600_000),
});
console.log(token);
process.exit(0);
