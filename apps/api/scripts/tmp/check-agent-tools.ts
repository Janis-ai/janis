import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(sql, { schema });

const agentId = '586895f3-8285-4a95-ae2d-b18f389d838d';
const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
const cfg = (agent?.config ?? {}) as Record<string, unknown>;
console.log('agent:', agent?.name);
console.log('tools:', JSON.stringify(cfg.tools ?? cfg.tool_configs ?? 'none', null, 1).slice(0, 2000));
const conns = await db.select().from(schema.connections).where(eq(schema.connections.workspaceId, agent!.workspaceId));
console.log('connections:', conns.map((c) => ({ id: c.id, kind: (c as Record<string, unknown>).kind, provider: (c as Record<string, unknown>).provider })));
await sql.end();
