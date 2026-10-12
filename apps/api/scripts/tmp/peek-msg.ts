import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select created_at, text from messages
  where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c' and direction='out'
  order by created_at desc limit 6`;
for (const r of rows) console.log('──', r.created_at, '──\n' + r.text.slice(0, 900) + '\n');
await sql.end();
