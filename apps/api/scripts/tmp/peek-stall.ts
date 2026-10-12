import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select status, attempts, last_error, next_attempt_at, created_at, now() as now
  from webhook_deliveries where id in (
    select id from webhook_deliveries
    where payload->>'janis_conversation_id' = '2c23320b-eef3-4694-a21f-85935ab0be8b'
  ) order by created_at`;
for (const r of rows) console.log(r.created_at.toISOString(), r.status, 'att=' + r.attempts, 'next=' + (r.next_attempt_at?.toISOString?.() ?? 'null'), (r.last_error ?? '').slice(0,160));
const msgs = await sql`
  select direction, left(text,100) as t, created_at from messages
  where conversation_id='2c23320b-eef3-4694-a21f-85935ab0be8b' order by created_at`;
for (const m of msgs) console.log(m.created_at.toISOString(), m.direction, JSON.stringify(m.t));
await sql.end();
