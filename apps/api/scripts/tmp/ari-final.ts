import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const ag = await db.execute(sql`
  select id, name, workspace_id from agents
  where id in ('a4225d6a-7293-4134-b7f5-2d3891722a91','586895f3-8285-4a95-ae2d-b18f389d838d','f454f596-338a-431f-b604-68535303317b')
     or workspace_id = '944d2822-c0e2-45f3-a484-2cbfd36fa8f9'`);
console.log('AGENTS', JSON.stringify(ag));
const runs = await db.execute(sql`
  select kind, batch_id, count(*)::int as n,
    count(*) filter (where passed) as ok, count(*) filter (where passed = false) as bad,
    min(created_at) as started
  from agent_test_runs where agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62'
  group by kind, batch_id order by started desc limit 8`);
console.log('RUNS', JSON.stringify(runs));
const tests = await db.execute(sql`
  select name from agent_tests where agent_id = 'fae34af5-2629-4367-b6eb-0e1cb331ef62' limit 15`);
console.log('TESTS', JSON.stringify(tests));
process.exit(0);
