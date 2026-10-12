import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const ws = await sql`select id, name from workspaces where name like 'Barry%'`;
console.table(ws);
const agents_ = await sql`select id, name, created_at from agents where workspace_id=${ws[0]?.id} order by created_at`;
console.table(agents_);
// tool calls land as payload on messages — find rows carrying them
const rows = await sql`
  select direction, payload, created_at from messages
  where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c'
    and created_at > '2026-10-09T04:19:00'
    and (payload::text like '%create_agent%' or payload::text like '%error%')
  order by created_at limit 10`;
for (const r of rows) console.log(r.created_at, r.direction, JSON.stringify(r.payload).slice(0, 600));
await sql.end();
