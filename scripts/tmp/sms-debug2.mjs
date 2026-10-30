import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const msgs = await sql`select direction, text, created_at, payload->>'via' via, payload->>'sms_pending' pending, payload->>'delivery_error' err from messages where conversation_id='6464c110-d160-4274-b06b-82f76cc0feb8' order by created_at desc limit 8`;
console.log(JSON.stringify(msgs, null, 1));
const binds = await sql`select channel_id, platform_user_id from channel_bindings where conversation_id='6464c110-d160-4274-b06b-82f76cc0feb8'`;
console.log('bindings:', JSON.stringify(binds));
const ident = await sql`select channel_id, platform_user_id, opted_out_at, sms_opted_in_at from contact_identities where platform_user_id='+16474542372'`;
console.log('identities:', JSON.stringify(ident));
await sql.end();
