import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const [ch] = await sql`select credentials from channels where id='44fe2e6f-473f-4a46-8b32-28563772a51d'`;
await sql.end();
const c = ch.credentials;
const auth = { Authorization: 'Basic ' + Buffer.from(`${c.twilio_account_sid}:${c.twilio_auth_token}`).toString('base64') };
const msgs = await (await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.twilio_account_sid}/Messages.json?To=${encodeURIComponent('+14152799179')}&PageSize=10`, { headers: auth })).json();
for (const m of msgs.messages ?? []) console.log(m.date_sent, m.direction, m.status, '| err:', m.error_code, m.error_message, '|', (m.body||'').slice(0,60));
