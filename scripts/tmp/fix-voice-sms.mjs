import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });

const VOICE = '947a1ca6-a62a-49df-a477-5b009686cd9c';
const API_ORIGIN = 'https://app.janis.ai';

const [voice] = await sql`select * from channels where id = ${VOICE}`;
if (!voice) { console.error('voice channel missing'); process.exit(1); }
const vc = voice.credentials;

// already has a sibling?
const existing = await sql`select id from channels where kind = 'sms'
  and credentials->>'phone_number' = ${vc.phone_number}`;
if (existing.length) { console.log('sibling already exists:', existing[0].id); process.exit(0); }

const credentials = {
  twilio_account_sid: vc.twilio_account_sid,
  twilio_auth_token: vc.twilio_auth_token,
  phone_number: vc.phone_number,
  hosted: vc.hosted,
  twilio_number_sid: vc.twilio_number_sid,
};
const [sms] = await sql`
  insert into channels (workspace_id, agent_id, kind, name, credentials)
  values (${voice.workspace_id}, ${voice.agent_id}, 'sms', ${'Janis voice SMS'}, ${sql.json(credentials)})
  returning id`;

// Repoint the number's SmsUrl at the live channel.
const sid = vc.twilio_account_sid, token = vc.twilio_auth_token;
const list = await (await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(vc.phone_number)}`,
  { headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') } },
)).json();
const numberSid = list.incoming_phone_numbers?.[0]?.sid;
if (!numberSid) { console.error('number not on account'); process.exit(1); }
const smsUrl = `${API_ORIGIN}/sms/${sms.id}`;
const upd = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${numberSid}.json`,
  { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
               'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: 'POST' }) });
console.log('new sms channel:', sms.id, '| SmsUrl set:', upd.status, '→', smsUrl);
await sql.end();
