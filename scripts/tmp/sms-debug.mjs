import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const chans = await sql`select id, kind, name, agent_id, credentials->>'phone_number' phone, credentials->>'twilio_account_sid' sid, created_at from channels where kind in ('sms','voice') order by created_at`;
console.log(JSON.stringify(chans, null, 1));
const recent = await sql`select c.id, c.external_id, c.last_message_at, m.direction, m.text, m.created_at, m.payload from conversations c left join messages m on m.conversation_id = c.id where c.external_id like 'sms:%' order by m.created_at desc limit 10`;
console.log('recent sms msgs:', JSON.stringify(recent, null, 1));
await sql.end();
