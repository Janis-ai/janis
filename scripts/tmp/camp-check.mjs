import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const [ch] = await sql`select credentials from channels where id='44fe2e6f-473f-4a46-8b32-28563772a51d'`;
await sql.end();
const c = ch.credentials;
const auth = { Authorization: 'Basic ' + Buffer.from(`${c.twilio_account_sid}:${c.twilio_auth_token}`).toString('base64') };
const get = async (u) => (await fetch(u, { headers: auth })).json();
const svcs = await get('https://messaging.twilio.com/v1/Services?PageSize=20');
for (const s of svcs.services ?? []) {
  const res = await get(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p`);
  for (const cp of res.compliance ?? res.us_app_to_people ?? []) {
    const full = await get(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p/${cp.sid}`);
    console.log(JSON.stringify({ svc: s.sid, campaign: cp.sid, status: full.campaign_status ?? full.campaignStatus, failure: full.failure_reason ?? full.failureReason, errors: full.errors, mock: full.mock }, null, 1));
  }
}
