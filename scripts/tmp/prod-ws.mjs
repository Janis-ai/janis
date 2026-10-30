import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const ws = await sql`select id, name, plan, created_at from workspaces order by created_at`;
console.log(JSON.stringify(ws, null, 1));
await sql.end();
