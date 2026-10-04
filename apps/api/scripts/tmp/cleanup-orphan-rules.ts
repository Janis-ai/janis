import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { alertRules } from '../../src/db/schema.js';
import { and, eq, gt } from 'drizzle-orm';
const db = await createDb();
// rules seeded by the crashed alert-reply-check run (last ~30 min, this agent)
const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const cutoff = new Date(Date.now() - 45 * 60_000);
const orphans = await db
  .select({ id: alertRules.id, kind: alertRules.kind })
  .from(alertRules)
  .where(and(eq(alertRules.agentId, AGENT_ID), gt(alertRules.createdAt, cutoff)));
console.log('orphans:', orphans.length, orphans.map((o) => o.kind).join(','));
if (orphans.length) {
  await db.delete(alertRules).where(and(eq(alertRules.agentId, AGENT_ID), gt(alertRules.createdAt, cutoff)));
  console.log('deleted');
}
process.exit(0);
