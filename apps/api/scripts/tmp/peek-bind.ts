import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const support = envv('JANIS_SUPPORT_CHANNEL_ID') ?? envv('SUPPORT_CHANNEL_ID');
console.log('support channel:', support);
const binds = await sql`
  select cb.platform_user_id, c.id as conv_id, c.external_id, c.state, count(m.id) as msgs
  from channel_bindings cb
  join conversations c on c.id = cb.conversation_id
  left join messages m on m.conversation_id = c.id
  where cb.channel_id = ${support}
  group by cb.platform_user_id, c.id, c.external_id, c.state
  order by msgs desc limit 15`;
console.table(binds);
const users = await sql`select id, email, name from users order by created_at desc limit 10`;
console.table(users);
await sql.end();
