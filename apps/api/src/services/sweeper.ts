import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, alertRules, alerts, conversations } from '../db/schema.js';
import { bus } from '../lib/bus.js';
import { notifyWorkspace } from '../lib/notify.js';
import { inactivityThresholds } from '../lib/rules.js';
import { toAlert } from '../lib/serializers.js';

/**
 * Periodically escalate 'active' conversations where the end user is waiting
 * (last message was inbound) and the agent's inactivity threshold has passed.
 */
export function startSweeper(db: Db, intervalMs = 60_000): () => void {
  const timer = setInterval(() => void sweep(db), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweep(db: Db): Promise<number> {
  const rules = await db.select().from(alertRules).where(eq(alertRules.kind, 'inactivity'));
  if (rules.length === 0) return 0;

  // smallest configured threshold per agent
  const thresholdByAgent = new Map<string, number>();
  for (const rule of rules) {
    for (const minutes of inactivityThresholds([rule])) {
      const current = thresholdByAgent.get(rule.agentId);
      if (current === undefined || minutes < current) thresholdByAgent.set(rule.agentId, minutes);
    }
  }

  let fired = 0;
  for (const [agentId, minutes] of thresholdByAgent) {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    const stale = await db
      .select({ conversation: conversations, agent: agents })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.state, 'active'),
          eq(conversations.lastMessageDirection, 'in'),
          lt(conversations.lastMessageAt, cutoff),
        ),
      );

    for (const { conversation, agent } of stale) {
      const [alert] = await db
        .insert(alerts)
        .values({
          conversationId: conversation.id,
          type: 'inactivity',
          detail: `no agent response for ${minutes}m`,
        })
        .returning();
      await db
        .update(conversations)
        .set({ state: 'needs_human' })
        .where(eq(conversations.id, conversation.id));
      bus.publish(agent.workspaceId, { type: 'alert', data: toAlert(alert) });
      bus.publish(agent.workspaceId, {
        type: 'conversation',
        data: { id: conversation.id, state: 'needs_human' },
      });
      void notifyWorkspace(db, agent.workspaceId, {
        title: 'Janis: user waiting',
        body: `No agent response for ${minutes}m in ${conversation.externalId}`,
        url: `/conversations/${conversation.id}`,
      });
      fired++;
    }
  }
  return fired;
}
