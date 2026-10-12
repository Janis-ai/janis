import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select direction, left(text,200) as text, payload->>'via' as via, payload->'action'->>'tool' as tool, created_at
  from messages where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c'
  order by created_at desc limit 14`;
console.table(rows.reverse());
await sql.end();
