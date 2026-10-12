import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const [a] = await sql`select config from agents where id='13e45248-77e9-4006-b8a5-76c442e522bd'`;
const c = a.config ?? {};
console.log(JSON.stringify({
  greeting_enabled: c.greeting_enabled, greeting: (c.greeting ?? '').slice(0, 50),
  quick_replies: c.quick_replies, csat: c.csat,
  sla_minutes: c.sla_minutes, auto_assign: c.auto_assign,
}, null, 1));
const [ch] = await sql`select credentials->>'accent' as accent from channels where agent_id='13e45248-77e9-4006-b8a5-76c442e522bd' and kind='bubble' limit 1`;
console.log('bubble accent:', ch?.accent);
await sql.end();
