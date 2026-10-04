import { createDb } from '../../src/db/client.js';
import { agents, channels, workspaces } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { toolsFor } from '../../src/lib/toolExec.js';
import { enabledBuiltins } from '../../src/lib/builtinTools.js';

const db = await createDb();
const all = await db.select().from(agents).where(eq(agents.name, 'Janis'));
console.log('agents named Janis:', all.length);
for (const agent of all) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId)).limit(1);
  const cfg = agent.config as { builtin_tools?: string[] } | null;
  const builtins = enabledBuiltins(cfg?.builtin_tools, agent.workspaceId);
  const tools = toolsFor(agent);
  const chans = await db.select().from(channels).where(eq(channels.agentId, agent.id));
  const rail = chans.find((c) => c.kind === 'webchat' && (c.credentials as {internal?:boolean}|null)?.internal);
  console.log('---');
  console.log('agent:', agent.id, '| ws:', ws?.name, agent.workspaceId, '| hosted:', agent.hosted);
  console.log('builtins:', builtins.length ? builtins.map(b => b.name).join(', ') : '(none)');
  console.log('custom/toolsFor:', tools.map(t => `${t.name}${t.widget?'[widget]':''}`).join(', ') || '(none)');
  console.log('rail channel:', rail?.id ?? '(none)');
}
process.exit(0);
