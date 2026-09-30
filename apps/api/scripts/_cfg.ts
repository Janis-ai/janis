import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const sql = postgres(readFileSync('/tmp/dburl.txt','utf8').trim(), { ssl: 'require' });
const [a] = await sql`select name, config from agents where id='8c02bcaa-11fb-4e1a-a413-f32c8e2a9912'`;
const c = a.config ?? {};
for (const k of ['system_prompt','greeting','tone','company_name','knowledge','llm']) {
  const v = c[k];
  console.log(k+':', typeof v === 'object' ? JSON.stringify(v).slice(0,200) : (v??'<unset>'));
}
console.log('config keys:', Object.keys(c).join(', '));
await sql.end();
