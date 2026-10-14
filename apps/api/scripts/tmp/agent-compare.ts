import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
for (const id of ['d408d7b5-fdad-49a4-a34d-11fa16e88135', '22f4cf25-bd8f-49d4-9f8e-a5a58a3ea3e4']) {
  const [a] = await db.select().from(schema.agents).where(eq(schema.agents.id, id));
  const cfg = (a.config ?? {}) as { tools?: { name: string }[]; system_prompt?: string };
  const tools = (cfg.tools ?? []).map((t) => t.name);
  const secs = await db.select({ name: schema.agentSecrets.name }).from(schema.agentSecrets).where(eq(schema.agentSecrets.agentId, id));
  const convs = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.agentId, id));
  console.log(`\n${a.name} (${id.slice(0,8)}) created ${a.createdAt?.toISOString().slice(0,16)}`);
  console.log('  prompt:', (cfg.system_prompt ?? '').length, 'chars | tools:', tools.length, tools.slice(0, 12).join(','));
  console.log('  secrets:', secs.map(s => s.name).join(',') || 'none');
  console.log('  conversations:', convs.length);
}
await sql.end();
