import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const out = await sql`select payload from messages where conversation_id='6464c110-d160-4274-b06b-82f76cc0feb8' and direction='out' order by created_at desc limit 3`;
for (const m of out) console.log(JSON.stringify({mid: m.payload?.mid, delivered: m.payload?.delivered, delivery_error: m.payload?.delivery_error, err: m.payload?.error}));
await sql.end();
