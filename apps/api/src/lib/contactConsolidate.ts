/** CRM-style contact consolidation — distills a conversation's transcript
 *  into structured contact fields on the bound contact. Unlike
 *  enrichContactClaimed (which only writes fields the visitor states),
 *  this learns what's implied: summary, job title, company, lifecycle,
 *  interests, durable facts — landed under metadata.learned so it never
 *  clobbers operator-entered fields or claimed traits. Runs from the
 *  sweep, bounded per tick so LLM cost stays a trickle. */
import { desc, eq, sql } from 'drizzle-orm';
import { agents, contacts, conversations, messages } from '../db/schema.js';
import { llmFor } from './llm.js';
import { recordLlmUsage } from './usage.js';
import type { Db } from '../db/client.js';

export type ContactLearned = {
  summary?: string;
  job_title?: string;
  company?: string;
  lifecycle?: string;
  interests?: string[];
  facts?: string[];
};

const EXTRACT_SYS =
  'You extract CRM fields from a customer-service conversation for the contact record. ' +
  'Return ONLY a JSON object with keys (omit any you cannot infer): ' +
  'summary (one sentence: who they are + what they wanted), job_title, company, ' +
  'lifecycle (one of lead|prospect|customer|churning), interests (array of topics they ' +
  'asked about, max 5), facts (array of durable facts — role, stack, company size, ' +
  'preferences — not one-off questions, max 6). Do not invent values.';

/** Distill one conversation → learned fields merged onto its contact.
 *  Returns true when a consolidation landed. */
export async function consolidateConversationContact(db: Db, convId: string): Promise<boolean> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (!conv?.contactId) return false;
  const rows = await db
    .select({ direction: messages.direction, text: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(30);
  const transcript = rows
    .reverse()
    .filter((m) => m.text)
    .map((m) => `${m.direction === 'in' ? 'Customer' : 'Agent'}: ${m.text}`)
    .join('\n')
    .slice(0, 8000);
  if (!transcript.trim()) return false;
  const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1);
  if (!agent) return false;
  const llm = await llmFor(db, agent);
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
      ...(llm.headers ?? {}),
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYS },
        { role: 'user', content: transcript },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  await recordLlmUsage(db, {
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    conversationId: conv.id,
    model: llm.model,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    byok: llm.byok,
  }).catch(() => {});
  let learned: ContactLearned;
  try {
    learned = JSON.parse(json.choices?.[0]?.message?.content ?? '{}') as ContactLearned;
  } catch {
    return false;
  }
  // Stamp consolidated_at even when the transcript yields nothing — the
  // sweep's "newer than last consolidation" check is the throttle, and an
  // unstamped conv would be re-extracted every tick forever. It re-picks
  // only when new messages land (lastMessageAt > consolidated_at).
  const has = Object.values(learned).some((v) =>
    Array.isArray(v) ? v.length > 0 : Boolean(v),
  );
  await db
    .update(contacts)
    .set({
      metadata: sql`jsonb_set(${contacts.metadata}, '{learned}', coalesce(${contacts.metadata}->'learned', '{}'::jsonb) || ${JSON.stringify({
        ...(has ? learned : {}),
        consolidated_at: new Date().toISOString(),
        source_conversation: conv.id,
      })}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, conv.contactId));
  return has;
}

/** Sweep pass — conversations with contact + inbound traffic newer than the
 *  contact's last consolidation, bounded per tick (LLM cost is a trickle).
 *  A failed extract leaves consolidated_at stale → retried next tick. */
export async function sweepContactConsolidation(db: Db, limit = 3): Promise<number> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      sql`${conversations.contactId} is not null
        and ${conversations.lastMessageAt} > now() - interval '30 days'
        and exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.direction = 'in')
        and coalesce(
          (select (c.metadata->'learned'->>'consolidated_at')::timestamptz
             from ${contacts} c where c.id = ${conversations.contactId}),
          '-infinity'::timestamptz
        ) < ${conversations.lastMessageAt}`,
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  let n = 0;
  for (const r of rows) {
    try {
      if (await consolidateConversationContact(db, r.id)) n++;
    } catch {
      // next tick retries
    }
  }
  return n;
}
