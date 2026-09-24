import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  alertRules,
  alerts,
  channelBindings,
  channels,
  conversations,
  digests,
  knowledgeFiles,
  agentSecrets,
  memberships,
  messages,
  metaConnections,
  savedReplies,
  sessions,
  slackInstallations,
  slackThreads,
  suggestions,
  usageEvents,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { stripe } from '../lib/stripe.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

export function workspaceRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // DELETE /api/workspace — permanently remove the workspace and every row
  // attached to it (no FK cascades, so children go first). Admin only.
  app.delete('/', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);

    // stop the meter before deleting — an active sub would keep billing
    if (ws.stripeSubscriptionId) {
      const s = stripe();
      if (s) {
        try {
          await s.subscriptions.cancel(ws.stripeSubscriptionId);
        } catch {
          // already canceled/gone on Stripe's side
        }
      }
    }

    const agentIds = (
      await db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))
    ).map((r) => r.id);
    const convIds = agentIds.length
      ? (
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(inArray(conversations.agentId, agentIds))
        ).map((r) => r.id)
      : [];
    // (users are workspace-independent now — memberships, not user rows, go)

    if (convIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(alerts).where(inArray(alerts.conversationId, convIds));
      await db.delete(suggestions).where(inArray(suggestions.conversationId, convIds));
      await db.delete(slackThreads).where(inArray(slackThreads.conversationId, convIds));
      await db.delete(channelBindings).where(inArray(channelBindings.conversationId, convIds));
    }
    // usage_events reference agents + conversations — gone before them
    await db.delete(usageEvents).where(eq(usageEvents.workspaceId, workspaceId));
    if (convIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }
    if (agentIds.length) {
      await db.delete(alertRules).where(inArray(alertRules.agentId, agentIds));
      await db.delete(knowledgeFiles).where(inArray(knowledgeFiles.agentId, agentIds));
      await db.delete(agentSecrets).where(inArray(agentSecrets.agentId, agentIds));
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.agentId, agentIds));
    }
    await db.delete(channels).where(eq(channels.workspaceId, workspaceId));
    if (agentIds.length) {
      await db.delete(agents).where(inArray(agents.id, agentIds));
    }
    // slack_installations.installer_user_id references users — before them
    await db.delete(slackInstallations).where(eq(slackInstallations.workspaceId, workspaceId));
    await db.delete(metaConnections).where(eq(metaConnections.workspaceId, workspaceId));
    await db.delete(savedReplies).where(eq(savedReplies.workspaceId, workspaceId));
    await db.delete(digests).where(eq(digests.workspaceId, workspaceId));
    // user rows survive — they may hold memberships elsewhere. Only the
    // workspace's memberships and the sessions pointed at it go.
    await db.delete(memberships).where(eq(memberships.workspaceId, workspaceId));
    await db.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

    return c.json({ ok: true });
  });

  return app;
}
