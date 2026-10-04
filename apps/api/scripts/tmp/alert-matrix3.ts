import { createDb } from '../../src/db/client.js';
import { alertRules, alerts, conversations, users } from '../../src/db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
const db = await createDb();
const AGENT = '13e45248-77e9-4006-b8a5-76c442e522bd';
const CONV_A = '44dccd1b'; // prefix — resolve below
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const [convA] = await db.select().from(conversations).where(eq(conversations.agentId, AGENT));
const convs = await db.select().from(conversations).where(eq(conversations.agentId, AGENT));
const conv = convs.find((c) => c.id.startsWith(CONV_A))!;
console.log('conv A:', conv.id, 'state:', conv.state, 'dir:', conv.lastMessageDirection);
const [rule] = await db.insert(alertRules).values({
  agentId: AGENT, kind: 'inactivity',
  config: { enabled: true, inactivity_minutes: 1, assign_to: u.id },
}).returning();
await db.update(conversations)
  .set({ lastMessageDirection: 'in', lastMessageAt: new Date(Date.now() - 90_000) })
  .where(eq(conversations.id, conv.id));
console.log('waiting ~150s for sweeper…');
await new Promise((r) => setTimeout(r, 150_000));
const rows = await db.select().from(alerts).where(and(eq(alerts.conversationId, conv.id), eq(alerts.type, 'inactivity'))).orderBy(desc(alerts.createdAt)).limit(3);
for (const a of rows) console.log(a.createdAt.toISOString().slice(11, 19), a.type, a.status, a.detail);
console.log(rows.length ? 'INACTIVITY FIRED' : 'still no inactivity alert');
await db.delete(alertRules).where(eq(alertRules.id, rule.id));
process.exit(0);
