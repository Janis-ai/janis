import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const rows = await sql`
  select created_at, payload->'inspector'->'tools' as tools, payload->'inspector'->'tool_calls' as calls,
         jsonb_array_length(coalesce(payload->'inspector'->'kb','[]'::jsonb)) as kb_n
  from messages
  where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c'
    and created_at > '2026-10-09T04:19:30' and direction='out'
  order by created_at`;
for (const r of rows) {
  console.log('===', r.created_at, 'kb entries injected:', r.kb_n);
  console.log(JSON.stringify(r.calls ?? r.tools, null, 1)?.slice(0, 2500));
}
await sql.end();
