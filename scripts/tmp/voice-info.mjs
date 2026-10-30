import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });
const rows = await sql`
  select c.id, c.kind, c.name, c.agent_id, c.workspace_id, a.name agent_name, w.name ws_name
  from channels c join agents a on a.id = c.agent_id join workspaces w on w.id = c.workspace_id
  where c.id in ('947a1ca6-a62a-49df-a477-5b009686cd9c','44fe2e6f-473f-4a46-8b32-28563772a51d')`;
console.log(JSON.stringify(rows, null, 1));
const dead = await sql`select id from channels where id = '20b6f214-2ab2-43ae-98aa-a88f87adfe55'`;
console.log('dead channel row:', JSON.stringify(dead));
await sql.end();
