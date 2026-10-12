import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select left(text,90) as text, payload, created_at
  from messages where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c'
  and (payload->>'internal' is not null or payload->>'kind' is not null or text like '%sentiment%' or text like '%Signed in%')
  order by created_at desc limit 8`;
for (const r of rows) console.log(JSON.stringify(r));
await sql.end();
