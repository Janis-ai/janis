import postgres from 'postgres';
import { readFileSync } from 'node:fs';
const WS = 'acd296f3-61e1-46c5-ae57-6cdbddbdca85'; // Michael's workspace (prod)
const emails = readFileSync(process.argv[2], 'utf8').split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
let inserted = 0;
for (const address of emails) {
  const r = await sql`
    insert into suppressions (workspace_id, address, kind, reason, source)
    values (${WS}, ${address}, 'email', 'manual', 'legacy_unsubscribed_lists')
    on conflict (workspace_id, address, kind) do nothing
    returning id`;
  inserted += r.length;
}
console.log(`${inserted}/${emails.length} inserted (rest already existed)`);
const check = await sql`select count(*) c from suppressions where workspace_id = ${WS} and source = 'legacy_unsubscribed_lists'`;
console.log('total legacy unsubs in table:', check[0].c);
await sql.end();
