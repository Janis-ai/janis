import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const ms = await sql`
  select w.id, w.name, u.email, m.role
  from memberships m join users u on u.id = m.user_id join workspaces w on w.id = m.workspace_id
  where u.email ilike '%nathanson%' or u.email ilike '%michael%'`;
for (const r of ms) console.log(r.email, '→', r.name, r.id, r.role);
// the digest rows for the concierge's own workspace (acd296f3)
const ds = await sql`
  select created_at, stats from digests
  where workspace_id='acd296f3-61e1-46c5-ae57-6cdbddbdca85' order by created_at desc limit 3`;
for (const d of ds) console.log('MICHAEL-WS DIGEST', d.created_at.toISOString(), JSON.stringify(d.stats));
// which workspace got the digest that hit the gmail conv — check digest table for zero rows
// around the times in the transcript (10-06 09:51, 10-07 11:19, 10-08 12:16, 10-09 15:41)
const all = await sql`
  select workspace_id, created_at, stats from digests
  where created_at > '2026-10-08' and stats->>'conversations' = '0'
  order by created_at desc limit 12`;
for (const d of all) console.log('ZERO-DIGEST', d.created_at.toISOString(), d.workspace_id);
await sql.end();
