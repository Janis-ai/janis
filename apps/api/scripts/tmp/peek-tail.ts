import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select id, length(text) as len, created_at,
         payload->'inspector'->>'model' as model
  from messages where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c' and direction='out'
  order by created_at desc limit 3`;
for (const r of rows) console.log(r.created_at, 'len=' + r.len, r.model);
await sql.end();
