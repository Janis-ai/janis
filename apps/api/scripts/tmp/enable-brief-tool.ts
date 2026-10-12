import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const [a] = await sql`select config from agents where id=${ID}`;
const c = a.config ?? {};
const tools: string[] = c.builtin_tools ?? [];
console.log('before:', tools.length, 'has update_agent_brief:', tools.includes('update_agent_brief'));
if (!tools.includes('update_agent_brief')) {
  tools.push('update_agent_brief');
  await sql`update agents set config=${sql.json({ ...c, builtin_tools: tools })} where id=${ID}`;
  console.log('after: appended —', tools.length, 'tools');
} else {
  console.log('already enabled');
}
await sql.end();
