import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const id = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
const r = await sql`update channels set credentials = credentials || '{"sms_footer": true}'::jsonb where id=${id} returning credentials->>'sms_footer' as f, agent_id`;
console.log(r);
await sql.end();
