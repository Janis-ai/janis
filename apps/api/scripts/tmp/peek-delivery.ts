import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select id, type, status, attempts, last_error, created_at,
         payload->>'conversation_id' as conv_ext
  from webhook_deliveries
  where agent_id = '13e45248-77e9-4006-b8a5-76c442e522bd'
    and created_at > '2026-10-09T14:04:00Z'
  order by created_at desc limit 15`;
for (const r of rows) console.log(r.created_at.toISOString(), r.status, 'att=' + r.attempts, (r.last_error ?? '').slice(0,300), '|', r.conv_ext);
await sql.end();
