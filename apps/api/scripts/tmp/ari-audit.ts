import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { workspaces, agents } from '../../src/db/schema.js';
import { ilike, or } from 'drizzle-orm';

const db = await createDb();

const ws = await db
  .select()
  .from(workspaces)
  .where(or(ilike(workspaces.name, '%ari%'), ilike(workspaces.name, '%jewish%')));
console.log('WORKSPACES', JSON.stringify(ws));

const ag = await db
  .select()
  .from(agents)
  .where(or(ilike(agents.name, '%jewish%'), ilike(agents.name, '%guide%')));
console.log('AGENTS', JSON.stringify(ag));

process.exit(0);
