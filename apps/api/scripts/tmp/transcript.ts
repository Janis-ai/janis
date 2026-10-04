import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { asc, eq } from 'drizzle-orm';
const db = await createDb();
const conv = process.argv[2] ?? '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const ms = await db.select().from(messages).where(eq(messages.conversationId, conv)).orderBy(asc(messages.createdAt));
for (const m of ms) {
  const p = m.payload as { inspector?: { tools?: {name:string;outcome:string;gated?:boolean}[]; model?:string }; link_guard?: {stripped?:string[];unverified?:string[]}; widgets?: unknown[]; action?: {tool?:string;status?:string} };
  const tag = m.direction === 'in' ? 'USER' : 'JANIS';
  console.log(`\n=== ${tag} ${m.createdAt.toISOString()}`);
  console.log((m.text ?? '(no text)').slice(0, 600));
  const tools = p.inspector?.tools ?? [];
  if (tools.length) console.log(`  [tools] ${tools.map((t) => `${t.name}:${t.outcome}${t.gated?'/gated':''}`).join(', ')}`);
  if (p.widgets?.length) console.log(`  [widgets] ${p.widgets.length} component(s): ${JSON.stringify(p.widgets).slice(0,300)}`);
  if (p.action) console.log(`  [approval] ${JSON.stringify(p.action).slice(0, 300)}`);
  if (p.link_guard && (p.link_guard.stripped?.length || p.link_guard.unverified?.length)) console.log(`  [link_guard] ${JSON.stringify(p.link_guard).slice(0,300)}`);
}
process.exit(0);
