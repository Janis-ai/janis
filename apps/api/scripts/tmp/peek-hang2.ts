import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const msgs = await sql`
  select direction, left(text,160) as t, created_at, flags,
         payload->'internal' as internal, payload->'inspector'->>'finish_reason' as fin
  from messages where conversation_id='2c23320b-eef3-4694-a21f-85935ab0be8b'
  order by created_at`;
for (const m of msgs) console.log(m.created_at.toISOString?.() ?? m.created_at, m.direction, 'int:'+JSON.stringify(m.internal), 'flags:'+JSON.stringify(m.flags), '\n   ', JSON.stringify(m.t));
// running/pending jobs for this conv?
const jobs = await sql`
  select id, kind, status, run_at, created_at, left(payload::text,200) as p
  from jobs where payload::text like '%2c23320b%' order by created_at desc limit 5`;
console.log('---jobs---');
for (const j of jobs) console.log(j.created_at, j.kind, j.status, j.run_at, j.p);
await sql.end();
