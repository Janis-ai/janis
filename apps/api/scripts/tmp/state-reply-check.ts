import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, conversations, messages, users } from '../../src/db/schema.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { processEvents } from '../../src/services/ingest.js';
import { deliverWebhook } from '../../src/lib/webhooks.js';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const STAMP = Date.now().toString(36);
const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);

for (const state of ['archived', 'human'] as const) {
  const extId = `statecheck-${state}-${STAMP}`;
  await processEvents(db, agent, [{ type: 'message_in', conversation_id: extId, text: 'first message' } as never]);
  const [conv] = await db.select().from(conversations).where(eq(conversations.externalId, extId)).limit(1);
  await db.update(conversations).set({ state }).where(eq(conversations.id, conv.id));

  await processEvents(db, agent, [{ type: 'message_in', conversation_id: extId, text: 'follow-up — anyone there?' } as never]);
  const [followup] = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(1);
  await deliverWebhook(db, agent, 'message.user', {
    conversation_id: extId, janis_conversation_id: conv.id, text: 'follow-up — anyone there?',
  } as never);

  const deadline = Date.now() + 60_000;
  let replied = false;
  while (Date.now() < deadline) {
    const [row] = await db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.conversationId, conv.id),
      eq(messages.direction, 'out'),
      sql`coalesce(${messages.payload}->>'internal', 'false') <> 'true'`,
      sql`coalesce((${messages.flags}->>'handoff_offer')::boolean, false) = false`,
      sql`${messages.createdAt} > ${followup.createdAt.toISOString()}`,
    )).limit(1);
    if (row) { replied = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const [now] = await db.select({ state: conversations.state }).from(conversations).where(eq(conversations.id, conv.id));
  console.log(`${state.padEnd(8)} → reply=${replied} (final state=${now.state})`);
}
process.exit(0);
