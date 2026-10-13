import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.execute(sql`
  select m.created_at::text, m.payload->'inspector'->'kb' as kb
  from messages m
  where m.conversation_id = '1d73382a-d2fd-4af8-8e83-874bb41c4746' and m.direction = 'out'
  order by m.created_at`);
for (const m of msgs as any[]) {
  if (!m.kb) continue;
  const rel = m.kb.filter((u: string) => /moberly|walmer|summerhill|roxborough|inglewood|sumach|backup|sold|sale|terms/.test(u));
  console.log(m.created_at, 'n=', m.kb.length, 'relevant:', JSON.stringify(rel));
}
// bed counts on the three real candidates
const beds = await db.execute(sql`
  select source_url,
    substring(text from '.{0,80}beds.{0,80}') as ctx1,
    substring(text from '.{0,60}Bedroom.{0,60}') as ctx2
  from knowledge_files
  where agent_id = 'f454f596-338a-431f-b604-68535303317b'
    and (source_url ~ 'moberly|walmerrd|summerhill|sumach' )
  order by source_url`);
console.log(JSON.stringify(beds, null, 1).slice(0, 3000));
process.exit(0);
