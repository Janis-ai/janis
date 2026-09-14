import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Digest } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, alerts, conversations, digests, messages, workspaces } from '../db/schema.js';
import { notifyWorkspace } from '../lib/notify.js';
import { toDigest } from '../lib/serializers.js';
import { postSlackMessage } from '../lib/slack.js';

export const DIGEST_PERIOD_MS = 24 * 60 * 60 * 1000; // daily digest

export async function computeDigestStats(
  db: Db,
  workspaceId: string,
  since: Date,
): Promise<Digest['stats']> {
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(agents.workspaceId, workspaceId));
  const convIds = convRows.map((r) => r.id);
  const recentMsgs = convIds.length
    ? await db
        .select()
        .from(messages)
        .where(and(inArray(messages.conversationId, convIds), gte(messages.createdAt, since)))
    : [];
  const newConvs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(and(eq(agents.workspaceId, workspaceId), gte(conversations.createdAt, since)));
  const recentAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .innerJoin(conversations, eq(alerts.conversationId, conversations.id))
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(and(eq(agents.workspaceId, workspaceId), gte(alerts.createdAt, since)));

  const humanConvs = new Set(
    recentMsgs.filter((m) => m.direction === 'human').map((m) => m.conversationId),
  );
  return {
    conversations: newConvs.length,
    messages_in: recentMsgs.filter((m) => m.direction === 'in').length,
    messages_out: recentMsgs.filter((m) => m.direction === 'out').length,
    messages_human: recentMsgs.filter((m) => m.direction === 'human').length,
    alerts: recentAlerts.length,
    takeovers: humanConvs.size,
  };
}

export function digestText(d: Digest): string {
  const s = d.stats;
  return (
    `Janis daily digest — ${s.conversations} new conversation(s), ` +
    `${s.messages_in} in / ${s.messages_out} out / ${s.messages_human} human, ` +
    `${s.alerts} alert(s), ${s.takeovers} conversation(s) had human takeover`
  );
}

export async function generateDigest(db: Db, workspaceId: string): Promise<Digest> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - DIGEST_PERIOD_MS);
  const stats = await computeDigestStats(db, workspaceId, periodStart);
  const [row] = await db
    .insert(digests)
    .values({ workspaceId, periodStart, periodEnd, stats })
    .returning();
  return toDigest(row);
}

/** Called periodically; emits one digest per workspace per DIGEST_PERIOD_MS. */
export async function emitDueDigests(db: Db): Promise<void> {
  const ws = await db.select().from(workspaces);
  for (const w of ws) {
    const [latest] = await db
      .select()
      .from(digests)
      .where(eq(digests.workspaceId, w.id))
      .orderBy(desc(digests.createdAt))
      .limit(1);
    if (latest && Date.now() - latest.createdAt.getTime() < DIGEST_PERIOD_MS) continue;
    const d = await generateDigest(db, w.id);
    const text = digestText(d);
    await notifyWorkspace(db, w.id, { title: 'Janis digest', body: text, url: '/reports' });
    await postSlackMessage(db, w.id, text);
  }
}
