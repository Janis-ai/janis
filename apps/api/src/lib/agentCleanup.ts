import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agentConnections,
  agentMembers,
  agentApiKeys,
  agentSecrets,
  agentTestRuns,
  agentTests,
  agentWidgets,
  alertRules,
  alerts,
  campaignSends,
  campaigns,
  channelBindings,
  channels,
  contactIdentities,
  conversations,
  evalSuggestions,
  formSubmissions,
  helpArticles,
  helpSearchLog,
  hookSubscriptions,
  knowledgeFiles,
  memberGroups,
  messages,
  pendingActions,
  savedReplies,
  shopifyShops,
  slackThreads,
  suggestions,
  usageEvents,
  webhookDeliveries,
} from '../db/schema.js';

/** No ON DELETE CASCADE anywhere — removing an agent means walking every
 *  agent-keyed table leaf-first. Shared by the single-agent delete route and
 *  the workspace delete so the two paths can't drift: a new agent-keyed
 *  table added here covers both. */
export async function deleteAgentsCascade(tx: Db, agentIds: string[]): Promise<void> {
  if (!agentIds.length) return;
  const convIds = (
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.agentId, agentIds))
  ).map((r) => r.id);
  const chanIds = (
    await tx.select({ id: channels.id }).from(channels).where(inArray(channels.agentId, agentIds))
  ).map((r) => r.id);

  // Agent-keyed flats first — several also reference conversations, so they
  // must go before the conv rows they point at.
  await tx.delete(pendingActions).where(inArray(pendingActions.agentId, agentIds));
  await tx.delete(evalSuggestions).where(inArray(evalSuggestions.agentId, agentIds));
  await tx.delete(formSubmissions).where(inArray(formSubmissions.agentId, agentIds));
  await tx.delete(agentTestRuns).where(inArray(agentTestRuns.agentId, agentIds));
  await tx.delete(agentTests).where(inArray(agentTests.agentId, agentIds));
  await tx.delete(agentWidgets).where(inArray(agentWidgets.agentId, agentIds));
  await tx.delete(hookSubscriptions).where(inArray(hookSubscriptions.agentId, agentIds));
  await tx.delete(agentApiKeys).where(inArray(agentApiKeys.agentId, agentIds));
  await tx.delete(shopifyShops).where(inArray(shopifyShops.agentId, agentIds));
  await tx.delete(memberGroups).where(inArray(memberGroups.agentId, agentIds));
  await tx.delete(helpSearchLog).where(inArray(helpSearchLog.agentId, agentIds));
  await tx.delete(helpArticles).where(inArray(helpArticles.agentId, agentIds));
  await tx.delete(knowledgeFiles).where(inArray(knowledgeFiles.agentId, agentIds));
  await tx.delete(alertRules).where(inArray(alertRules.agentId, agentIds));
  await tx.delete(agentSecrets).where(inArray(agentSecrets.agentId, agentIds));
  await tx.delete(agentConnections).where(inArray(agentConnections.agentId, agentIds));
  await tx.delete(agentMembers).where(inArray(agentMembers.agentId, agentIds));
  await tx.delete(webhookDeliveries).where(inArray(webhookDeliveries.agentId, agentIds));
  await tx.delete(usageEvents).where(inArray(usageEvents.agentId, agentIds));
  await tx.delete(savedReplies).where(inArray(savedReplies.agentId, agentIds));

  if (convIds.length) {
    await tx.delete(alerts).where(inArray(alerts.conversationId, convIds));
    await tx.delete(suggestions).where(inArray(suggestions.conversationId, convIds));
    await tx.delete(slackThreads).where(inArray(slackThreads.conversationId, convIds));
    await tx.delete(channelBindings).where(inArray(channelBindings.conversationId, convIds));
    await tx.delete(messages).where(inArray(messages.conversationId, convIds));
    await tx.delete(conversations).where(inArray(conversations.id, convIds));
  }
  if (chanIds.length) {
    await tx.delete(channelBindings).where(inArray(channelBindings.channelId, chanIds));
    // Channel-keyed dependents without cascade — campaign sends before
    // campaigns (send rows reference their campaign).
    await tx.delete(campaignSends).where(inArray(campaignSends.channelId, chanIds));
    await tx.delete(campaigns).where(inArray(campaigns.channelId, chanIds));
    await tx.delete(contactIdentities).where(inArray(contactIdentities.channelId, chanIds));
    await tx.delete(channels).where(inArray(channels.id, chanIds));
  }
  // The agents row itself is the caller's — the single-agent route deletes
  // with .returning() for its 404.
}
