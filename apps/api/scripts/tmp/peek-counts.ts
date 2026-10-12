import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const rows = await sql`select a.name, count(t.id)::int n from agent_tests t join agents a on a.id = t.agent_id group by a.name order by n desc limit 10`;
console.log(rows);
const total = await sql`select count(*)::int n from agent_tests`;
console.log('total', total[0].n);
await sql.end();
