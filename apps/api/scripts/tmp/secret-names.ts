import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select({ name: schema.agentSecrets.name }).from(schema.agentSecrets)
  .where(eq(schema.agentSecrets.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
console.log(rows.map(r => r.name).join('\n'));
// connections row for storefront password
const { connections } = schema;
const conns = await db.select({ id: connections.id, kind: connections.kind, creds: connections.credentials })
  .from(connections).where(eq(connections.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
for (const c of conns) console.log('conn', c.kind, JSON.stringify(Object.keys((c.creds as object) ?? {})));
await sql.end();
