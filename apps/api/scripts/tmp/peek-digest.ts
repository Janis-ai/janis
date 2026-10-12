import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
// which workspaces exist and which agents live in each
const ws = await sql`
  select w.id, w.name, count(a.id) as agents
  from workspaces w left join agents a on a.workspace_id = w.id
  group by w.id, w.name`;
for (const w of ws) console.log('WS', w.id, w.name, 'agents:' + w.agents);
// concierge's workspace
const [conc] = await sql`select workspace_id from agents where id='13e45248-77e9-4006-b8a5-76c442e522bd'`;
console.log('concierge workspace:', conc.workspace_id);
// digests emitted lately
const ds = await sql`select workspace_id, created_at, stats from digests order by created_at desc limit 6`;
for (const d of ds) console.log('DIGEST', d.created_at.toISOString(), d.workspace_id, JSON.stringify(d.stats));
// conversations per workspace in last 24h
const cv = await sql`
  select a.workspace_id, count(*) as n,
    count(*) filter (where c.created_at > now() - interval '24 hours') as new24
  from conversations c join agents a on a.id = c.agent_id
  group by a.workspace_id`;
for (const r of cv) console.log('CONVS', r.workspace_id, 'total:' + r.n, 'new24h:' + r.new24);
await sql.end();
