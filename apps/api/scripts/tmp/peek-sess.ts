import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const cols = await sql`select column_name from information_schema.columns where table_name='conversations' order by ordinal_position`;
console.log(cols.map((r) => r.column_name).join(', '));
const [c] = await sql`select external_id, created_at from conversations where id='0fab2dc1-efb6-4108-94ad-8b449db3b26c'`;
console.log('conv:', c);
await sql.end();
