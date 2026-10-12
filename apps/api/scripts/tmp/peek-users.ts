import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const mems = await sql`
  select u.email, m.role, w.name as workspace, m.created_at
  from memberships m join users u on u.id = m.user_id join workspaces w on w.id = m.workspace_id
  order by m.created_at desc limit 12`;
console.table(mems);
const msgs = await sql`
  select direction, left(text,80) as text, created_at from messages
  where conversation_id='0fab2dc1-efb6-4108-94ad-8b449db3b26c' order by created_at limit 10`;
console.table(msgs);
await sql.end();
