import './loadEnv.js';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDb, migrateDb } from './db/client.js';
import { env } from './env.js';
import { ensureSeed } from './services/seed.js';
import { acquireLock, startSweeper } from './services/sweeper.js';
import { emitDueDigests } from './services/digest.js';
import { bus } from './lib/bus.js';

const db = await createDb();
await migrateDb(db);
bus.attachDb(db);
await ensureSeed(db);
startSweeper(db);
setInterval(() => {
  void acquireLock(db, 'digest', 2 * 60 * 60 * 1000)
    .then(async (won) => {
      if (won) await emitDueDigests(db);
    })
    .catch(() => {});
}, 60 * 60 * 1000); // hourly check — leader-locked so N instances emit once

const app = createApp(db);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`janis-api listening on http://localhost:${info.port}`);
});
