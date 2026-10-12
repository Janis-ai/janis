import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const msgs = await sql`
  select direction, author_id, left(text, 400) as text, payload->>'kind' as kind, created_at
  from messages where conversation_id = '1fb291f8-c3f9-422d-bf3d-09766829efb6'
  order by created_at desc limit 20`;
for (const m of msgs.reverse()) console.log(`[${m.created_at}] ${m.direction} ${m.kind ?? ''}\n  ${m.text}\n`);
await sql.end();
