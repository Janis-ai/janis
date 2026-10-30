import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const us = await sql`select id, email, name, created_at from users where email ilike '%loan%' or name ilike '%loan%'`;
for (const u of us) {
  const ws = await sql`select w.id, w.name, w.plan, w.stripe_customer_id is not null as has_cust, w.stripe_subscription_id, w.trialed_at, w.parent_workspace_id from memberships m join workspaces w on w.id=m.workspace_id where m.user_id=${u.id}`;
  console.log(u.email, '|', u.name, '→', JSON.stringify(ws));
}
console.log('users found:', us.length);
await sql.end();
