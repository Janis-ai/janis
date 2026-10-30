// Dump the legacy unsubscribed addresses excluded at segmentation time
// (users_archived.unsubscribed_lists.* === true) → OUT csv.
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'node:fs';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('set MONGODB_URI'); process.exit(1); }
const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGO_DB ?? 'wordhopapi');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const rows = [];
for await (const u of db.collection('users_archived').find(
  { 'unsubscribed_lists': { $exists: true } },
  { projection: { 'profile.email': 1, 'slack.user.profile.email': 1, 'google.email': 1, unsubscribed_lists: 1 } },
)) {
  if (!(u.unsubscribed_lists && Object.values(u.unsubscribed_lists).some(Boolean))) continue;
  const email = (u.profile?.email || u.slack?.user?.profile?.email || u.google?.email || '').toLowerCase().trim();
  if (!email || !EMAIL_RE.test(email)) continue;
  rows.push(email);
}
await client.close();
const uniq = [...new Set(rows)];
writeFileSync(process.argv[2], 'email\n' + uniq.join('\n') + '\n');
console.log(`wrote ${uniq.length} unsubscribed emails to ${process.argv[2]}`);
