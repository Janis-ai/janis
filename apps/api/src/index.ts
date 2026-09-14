import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb, migrateDb } from './db/client.js';
import { env } from './env.js';
import { ensureSeed } from './services/seed.js';
import { startSweeper } from './services/sweeper.js';
import { emitDueDigests } from './services/digest.js';

const db = await createDb();
await migrateDb(db);
await ensureSeed(db);
startSweeper(db);
setInterval(() => void emitDueDigests(db).catch(() => {}), 60 * 60 * 1000); // hourly check

const app = createApp(db);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`janis-api listening on http://localhost:${info.port}`);
});
