import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { sql, eq, desc, and, gte } from 'drizzle-orm';
import { agents, conversations, messages, usageEvents } from '../../src/db/schema.js';

const db = await createDb();
const AGENT = 'fae34af5-2629-4367-b6eb-0e1cb331ef62';
const WS = '944d2822-c0e2-45f3-a484-2cbfd36fa8f9';

const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT));
console.log('LLM CONFIG', JSON.stringify((agent.config as any).llm ?? null));
console.log('AGENT TOOLS', JSON.stringify(((agent.config as any).tools ?? []).map((t: any) => t.name)));

const convs = await db
  .select({ id: conversations.id, state: conversations.state, externalId: conversations.externalId, createdAt: conversations.createdAt })
  .from(conversations)
  .where(eq(conversations.agentId, AGENT))
  .orderBy(desc(conversations.createdAt))
  .limit(15);
console.log('CONVS', JSON.stringify(convs, null, 1));

const recent = await db.execute(
  sql`select id, direction, left(text, 160) as text, created_at,
      payload->>'tools' as tools, payload->>'error' as err, payload->>'run_issues' as issues,
      payload->>'internal' as internal
      from messages where conversation_id in (select id from conversations where agent_id = ${AGENT})
      order by created_at desc limit 40`,
);
console.log('MSGS', JSON.stringify(recent, null, 1));

const usage = await db
  .select({ kind: usageEvents.kind, model: usageEvents.model, ts: usageEvents.createdAt })
  .from(usageEvents)
  .where(and(eq(usageEvents.workspaceId, WS), gte(usageEvents.createdAt, new Date(Date.now() - 72 * 3600e3))))
  .orderBy(desc(usageEvents.createdAt))
  .limit(50);
console.log('USAGE', JSON.stringify(usage, null, 1));

process.exit(0);
