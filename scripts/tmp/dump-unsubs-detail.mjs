import { MongoClient } from 'mongodb';
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db('wordhopapi');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const out = [];
for await (const u of db.collection('users_archived').find(
  { 'unsubscribed_lists': { $exists: true } },
  { projection: { 'profile.email': 1, 'slack.user.profile.email': 1, 'google.email': 1, 'profile.real_name': 1, 'profile.name': 1, unsubscribed_lists: 1 } },
)) {
  const lists = u.unsubscribed_lists && Object.entries(u.unsubscribed_lists).filter(([, v]) => v).map(([k]) => k);
  if (!lists.length) continue;
  const email = (u.profile?.email || u.slack?.user?.profile?.email || u.google?.email || '').toLowerCase().trim();
  out.push({ email: email || '(none)', name: u.profile?.real_name || u.profile?.name || '', lists, valid: EMAIL_RE.test(email) });
}
await client.close();
for (const r of out.sort((a, b) => a.email.localeCompare(b.email))) console.log(JSON.stringify(r));
