import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { busEvents } from '../../src/db/schema.js';
import { desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(busEvents).orderBy(desc(busEvents.id)).limit(8);
for (const r of rows) console.log(r.id, r.origin?.slice(0,8), JSON.stringify(r.event).slice(0,110));
process.exit(0);
