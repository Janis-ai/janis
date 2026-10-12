import fs from 'node:fs';
import postgres from 'postgres';
const envv = (k: string) =>
  fs.readFileSync('.env.production', 'utf8').split('\n')
    .find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim().replace(/^["']|["']$/g, '');
const sql = postgres(envv('DATABASE_URL')!, { max: 1 });
const [a] = await sql`select config->'knowledge' as kb from agents where id='13e45248-77e9-4006-b8a5-76c442e522bd'`;
const kb = (a?.kb ?? []) as string[];
console.log('entries:', kb.length);
for (const e of kb) {
  if (e.includes('action card') || e.includes('/agents/<')) console.log('---', e.slice(0, 300));
}
await sql.end();
