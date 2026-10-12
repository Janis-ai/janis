import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select text from messages
  where conversation_id='1fb291f8-c3f9-422d-bf3d-09766829efb6' and direction='out'
  order by created_at desc limit 3`;
for (const r of rows) console.log('═══════\n' + r.text + '\n');
await sql.end();
