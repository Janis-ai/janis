import { createDb } from '../../src/db/client.js';
import { agentTests } from '../../src/db/schema.js';
import { desc, eq, like } from 'drizzle-orm';
const db = await createDb();
const ts = await db.select().from(agentTests).where(eq(agentTests.agentId, '13e45248-77e9-4006-b8a5-76c442e522bd')).orderBy(desc(agentTests.createdAt)).limit(10);
for (const t of ts.filter(t => t.name.startsWith('Live concierge'))) {
  const turns = t.turns as { role: string; text: string }[];
  const cust = turns.filter(x => x.role === 'customer').map(x => x.text.slice(0, 60));
  console.log(t.name, '| customer turns:', JSON.stringify(cust));
}
process.exit(0);
