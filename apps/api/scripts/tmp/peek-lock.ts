import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const conv = '2c23320b-eef3-4694-a21f-85935ab0be8b';
const locks = await sql`
  select pid, classid, objid, granted from pg_locks where locktype = 'advisory'`;
console.log('advisory locks:', locks);
const key = await sql`select hashtext(${conv}) as k`;
console.log('conv lock key (objid):', key[0].k);
const acts = await sql`
  select pid, state, now() - query_start as age, wait_event, left(query,110) as q
  from pg_stat_activity where state is not null and pid <> pg_backend_pid()
  order by query_start desc limit 20`;
for (const a of acts) console.log(a.pid, a.state, a.age ?? '', a.wait_event ?? '', '|', a.q);
await sql.end();
