import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, conversations, messages } from '../db/schema.js';
import { bus } from './bus.js';
import { deliverToChannel } from './channels.js';
import { toMessage } from './serializers.js';

const PROMPT =
  "How was your experience? Reply with a rating from 1 (poor) to 5 (great).";
const THANKS = 'Thanks for the feedback!';

type Conv = typeof conversations.$inferSelect;

/**
 * Post-resolution satisfaction prompt — sent once when an operator archives a
 * conversation that actually had two-way traffic. The customer's next reply is
 * captured as the rating (see captureCsat) instead of reaching the agent.
 */
export async function sendCsatPrompt(db: Db, conv: Conv): Promise<void> {
  if (conv.csatAskedAt) return; // one ask per conversation
  const [exchange] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .limit(1);
  if (!exchange || exchange.n < 2) return; // nobody talked — nothing to rate
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: PROMPT,
      payload: { via: 'csat' },
    })
    .returning();
  await db
    .update(conversations)
    .set({ csatPending: true, csatAskedAt: new Date() })
    .where(eq(conversations.id, conv.id));
  const [agent] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, conv.agentId))
    .limit(1);
  if (agent) bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
  await deliverToChannel(db, conv.id, PROMPT, undefined, { messageId: note.id });
}

/** "5", "4!", "3 - ok", "2/5" → rating; anything else → not a rating. */
export function parseCsatRating(text: string): number | null {
  const m = /^\s*([1-5])(?=\s|[^\d]|$)/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Consume an inbound reply as a CSAT rating when the conversation has a
 * pending prompt. A non-rating reply just clears the prompt and flows on to
 * the agent normally.
 */
export async function captureCsat(db: Db, conv: Conv, text: string): Promise<boolean> {
  if (!conv.csatPending) return false;
  const score = parseCsatRating(text);
  await db
    .update(conversations)
    .set({ csatPending: false, ...(score !== null ? { csatScore: score } : {}) })
    .where(and(eq(conversations.id, conv.id), eq(conversations.csatPending, true)));
  if (score === null) return false;
  const [note] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'out',
      text: THANKS,
      payload: { via: 'csat', score },
    })
    .returning();
  const [agent] = await db
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, conv.agentId))
    .limit(1);
  if (agent) bus.publish(agent.workspaceId, { type: 'message', data: toMessage(note) });
  await deliverToChannel(db, conv.id, THANKS, undefined, { messageId: note.id });
  return true;
}
