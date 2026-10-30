import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const rows = await sql`select direction, author, text, created_at from messages where conversation_id='e65b1aa2-92b7-4e51-a52f-d3a4dcce0b7e' order by created_at asc limit 40`;
for (const m of rows) console.log(`\n[${m.direction}]`, (m.text||'').slice(0,900));
await sql.end();
