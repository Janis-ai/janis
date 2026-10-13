import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const A = 'f454f596-338a-431f-b604-68535303317b';
const ag = await db.execute(sql`
  select a.name, a.hosted, a.workspace_id, w.name as ws,
    jsonb_pretty(a.config) as config
  from agents a join workspaces w on w.id = a.workspace_id where a.id = ${A}`);
console.log('AGENT', JSON.stringify(ag));
const kn = await db.execute(sql`
  select name, source_url, status, char_count, refresh_hours, left(content, 300) as sample
  from knowledge_files where agent_id = ${A} order by created_at`);
console.log('KNOWLEDGE', JSON.stringify(kn));
process.exit(0);
