import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const chans = await sql`select id, kind, name, credentials from channels where kind in ('sms','voice')`;
await sql.end();
for (const ch of chans) {
  const cr = ch.credentials || {};
  const sid = cr.twilio_account_sid, token = cr.twilio_auth_token, num = cr.phone_number;
  if (!sid || !num) { console.log(ch.kind, ch.name, num, '→ no twilio creds'); continue; }
  const tok = token && token.startsWith('enc:') ? '(encrypted — cannot call)' : token;
  console.log(ch.kind, ch.name, num, 'sid:', sid, 'token:', tok ? 'present' : 'missing');
  if (!tok || tok.startsWith('(')) continue;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(num)}`,
    { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') } });
  const list = await res.json();
  const n = list.incoming_phone_numbers?.[0];
  console.log('  SmsUrl:', n?.sms_url ?? '(number not found on account)');
}
