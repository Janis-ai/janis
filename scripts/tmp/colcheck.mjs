import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const c = await sql`select column_name from information_schema.columns where table_name='contact_identities' and column_name='sms_opted_in_at'`;
console.log('column:', JSON.stringify(c));
await sql.end();
