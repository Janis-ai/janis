import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const rows = await sql`select id, kind, credentials->>'sms_footer' as sms_footer, credentials->>'public_id' as pub, name from channels where kind in ('webchat','sms','chat') order by created_at desc limit 30`;
for (const r of rows) console.log(r.id.slice(0,8), r.kind, 'sms_footer:', r.sms_footer, '| pub:', r.pub, '|', (r.name||'').slice(0,40));
await sql.end();
