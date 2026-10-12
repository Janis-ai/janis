import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
// concierge agent's newest conversations
const convs = await sql`
  select id, external_id, state, last_message_at, last_message_preview, created_at
  from conversations where agent_id='13e45248-77e9-4006-b8a5-76c442e522bd'
  order by created_at desc limit 6`;
for (const c of convs) console.log(c.id, c.external_id, c.state, c.last_message_at, JSON.stringify(c.last_message_preview));
console.log('---latest thread msgs---');
const msgs = await sql`
  select direction, left(text,120) as t, created_at, flags, payload->'internal' as internal
  from messages where conversation_id=${convs[0].id} order by created_at desc limit 8`;
for (const m of msgs.reverse()) console.log(m.created_at.toISOString?.() ?? m.created_at, m.direction, m.internal ?? '', JSON.stringify(m.t));
await sql.end();
