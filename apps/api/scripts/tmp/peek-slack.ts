import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
// find the outbound message with that reply text
const outs = await sql`
  select m.conversation_id, m.created_at, left(m.text,120) t, c.agent_id, c.external_id, c.state
  from messages m join conversations c on c.id = m.conversation_id
  where m.direction = 'out' and m.text like 'It seems like we are seeing the same report%'
  order by m.created_at desc limit 5`;
for (const o of outs) console.log('OUT', o.created_at.toISOString(), o.conversation_id, o.agent_id, o.external_id, o.state);
// and the transcript + slack bindings of that conversation
for (const o of outs.slice(0,1)) {
  const msgs = await sql`
    select direction, left(text,150) t, created_at, payload->>'slack_ts' as sts, payload->>'internal' as internal
    from messages where conversation_id=${o.conversation_id} order by created_at desc limit 12`;
  console.log('--- transcript', o.conversation_id);
  for (const m of msgs.reverse()) console.log(m.created_at.toISOString(), m.direction, 'int:'+m.internal, 'sts:'+m.sts, JSON.stringify(m.t));
  const th = await sql`select channel_id, ts, conversation_id, created_at from slack_threads where conversation_id=${o.conversation_id}`;
  console.log('--- slack_threads', th);
}
await sql.end();
