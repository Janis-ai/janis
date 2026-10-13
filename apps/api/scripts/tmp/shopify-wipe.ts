// Fresh-slate wipe for the Shopify dev store: deletes the shopify_shops
// row, then the bound agent with the same leaf-first cascade the console
// agent-delete route uses. DESTRUCTIVE — run only on the dev store.
import { createDb } from '../../src/db/client.js';
import {
  agentConnections,
  agentMembers,
  agentSecrets,
  agentTests,
  agents,
  alertRules,
  alerts,
  campaignSends,
  campaigns,
  channelBindings,
  channels,
  contacts,
  contactIdentities,
  conversations,
  helpArticles,
  helpSearchLog,
  knowledgeFiles,
  messages,
  pendingActions,
  savedReplies,
  shopifyShops,
  slackThreads,
  suggestions,
  usageEvents,
  webhookDeliveries,
} from '../../src/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';

const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();

const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP));
if (!row) {
  console.log('no shopify_shops row for', SHOP);
  process.exit(0);
}
console.log('shop row:', { state: row.state, agentId: row.agentId });
await db.delete(shopifyShops).where(eq(shopifyShops.id, row.id));

const agentId = row.agentId;
if (!agentId) {
  console.log('no bound agent — done');
  process.exit(0);
}

// Same cascade as DELETE /api/agents/:id — leaf-first, no FK cascade in schema.
const convIds = (
  await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.agentId, agentId))
).map((r) => r.id);
const chanIds = (
  await db.select({ id: channels.id }).from(channels).where(eq(channels.agentId, agentId))
).map((r) => r.id);
await db.transaction(async (tx) => {
  await tx.delete(pendingActions).where(eq(pendingActions.agentId, agentId));
  await tx.delete(usageEvents).where(eq(usageEvents.agentId, agentId));
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
    await tx.delete(campaignSends).where(inArray(campaignSends.channelId, chanIds));
    await tx.delete(campaigns).where(inArray(campaigns.channelId, chanIds));
    await tx.delete(contactIdentities).where(inArray(contactIdentities.channelId, chanIds));
    await tx.delete(channels).where(inArray(channels.id, chanIds));
  }
  await tx.delete(helpSearchLog).where(eq(helpSearchLog.agentId, agentId));
  await tx.delete(helpArticles).where(eq(helpArticles.agentId, agentId));
  await tx.delete(agentTests).where(eq(agentTests.agentId, agentId));
  await tx.delete(knowledgeFiles).where(eq(knowledgeFiles.agentId, agentId));
  await tx.delete(savedReplies).where(eq(savedReplies.agentId, agentId));
  await tx.delete(alertRules).where(eq(alertRules.agentId, agentId));
  await tx.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
  await tx.delete(agentConnections).where(eq(agentConnections.agentId, agentId));
  await tx.delete(agentMembers).where(eq(agentMembers.agentId, agentId));
  await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.agentId, agentId));
  await tx.delete(agents).where(eq(agents.id, agentId));
});
console.log(`deleted agent ${agentId} (${convIds.length} convs, ${chanIds.length} channels)`);
// Contacts the webchat convs created stay — they're workspace-scoped and a
// fresh install mints new ones; harmless either way.
process.exit(0);
