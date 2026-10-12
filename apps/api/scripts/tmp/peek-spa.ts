import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select conversation_id, created_at, length(text) as len from messages
  where direction='out' and text like '%single-page application%'
  order by created_at desc limit 5`;
for (const r of rows) console.log(r.created_at, r.conversation_id, 'len=' + r.len);
await sql.end();
