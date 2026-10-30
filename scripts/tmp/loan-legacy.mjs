import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
const envFile = process.env.LEGACY_ENV;
const uri = envFile.split('\n').filter(l => l.startsWith('MONGODB_URI') && !l.trim().startsWith('#')).pop().split('=').slice(1).join('=').trim().replace(/^"|"$/g,'');
const m = new MongoClient(uri);
await m.connect();
const db = m.db();
const us = await db.collection('users_archived').find({ $or: [ {'profile.email': /loankhanh2007/i}, {'google.email': /loankhanh2007/i}, {'slack.user.profile.email': /loankhanh2007/i} ] }).project({ 'profile.email':1, 'google.email':1, stripe_customer:1, stripe_subscription:1, team_id:1 }).toArray();
for (const u of us) {
  const subs = u.stripe_customer?.subscriptions?.data?.filter(s => s.items?.data?.some(i => (i.plan?.amount ?? 0) > 0 || (i.price?.unit_amount ?? 0) > 0));
  console.log(u.profile?.email ?? u.google?.email, '| docs paid-subs:', subs?.length ?? 0, '| team:', u.team_id);
  if (u.team_id) {
    const t = await db.collection('teams_archived').findOne({ id: u.team_id });
    console.log('  team:', t?.name, '| team paid-subs:', t?.stripe_customer?.subscriptions?.data?.filter(s=>s.items?.data?.some(i=>(i.plan?.amount??i.price?.unit_amount??0)>0)).length ?? 'n/a');
  }
}
console.log('docs:', us.length);
await m.close();
