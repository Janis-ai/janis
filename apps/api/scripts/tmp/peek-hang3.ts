import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const conv = '2c23320b-eef3-4694-a21f-85935ab0be8b';
const msgs = await sql`
  select direction, left(text,120) as t, created_at
  from messages where conversation_id = ${conv} order by created_at`;
console.log('--- transcript');
for (const m of msgs) console.log(m.created_at.toISOString(), m.direction, JSON.stringify(m.t));
const dels = await sql`
  select status, attempts, last_error, created_at, now() - created_at as age
  from webhook_deliveries where agent_id='13e45248-77e9-4006-b8a5-76c442e522bd'
    and created_at > '2026-10-09T14:04:00Z' order by created_at desc`;
console.log('--- deliveries');
for (const d of dels) console.log(d.created_at.toISOString(), d.status, 'age=' + d.age, (d.last_error ?? '').slice(0,200));
await sql.end();
