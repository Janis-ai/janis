import type { OutboundWebhook } from '@janis/shared';
import type { Db } from '../db/client.js';
import type { agents, conversations } from '../db/schema.js';
import { processEvents } from '../services/ingest.js';
import { loadSecretsMap } from './secrets.js';
import { detectIntent, type ServiceAccount } from './dialogflow.js';
import { sendRawFbMessage } from './channels.js';
import { reportLegacyUsage } from './legacyBilling.js';

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/** Human-readable stand-in for a raw Messenger payload in the transcript. */
function fbSummary(fb: Record<string, unknown>): string {
  if (typeof fb.text === 'string' && fb.text.trim()) return fb.text;
  const att = fb.attachment as { type?: string } | undefined;
  if (att?.type) return `[${att.type === 'template' ? 'card' : att.type}]`;
  if (Array.isArray(fb.quick_replies)) return '[quick replies]';
  return '[rich message]';
}

/**
 * Legacy engine: migrated wordhopapi bots. Inbound text goes to Dialogflow
 * ES (service account in agent secrets as DIALOGFLOW_SA_JSON); fulfillment
 * replies go back out as ordinary message_out events — text is delivered by
 * ingest, payload.facebook objects are sent verbatim via the page token.
 * A DF fallback intent is logged as a failure so alert rules can page a
 * human — same role Janis played on the old stack. The bot keeps replying;
 * only a human takeover (state 'human') silences it, enforced upstream.
 */
export async function runLegacyReply(
  db: Db,
  agent: AgentRow,
  event: OutboundWebhook,
  conv: ConversationRow,
): Promise<void> {
  const externalId = conv.externalId;
  const emit = (e: Parameters<typeof processEvents>[2]) => processEvents(db, agent, e);

  const dfCfg = (agent.config as { dialogflow?: { project: string; lang?: string } }).dialogflow;
  if (!dfCfg?.project) {
    await emit([{ type: 'failure', conversation_id: externalId, reason: 'legacy bot missing dialogflow project' }]);
    return;
  }
  const secrets = await loadSecretsMap(db, agent.id);
  let sa: ServiceAccount | undefined;
  try {
    sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
  } catch {}
  if (!sa?.client_email || !sa.private_key) {
    await emit([{ type: 'failure', conversation_id: externalId, reason: 'legacy bot missing DIALOGFLOW_SA_JSON secret' }]);
    return;
  }
  const text = event.text?.trim();
  if (!text) return;

  try {
    const r = await detectIntent(dfCfg.project, conv.id, text, dfCfg.lang ?? 'en', sa);
    void reportLegacyUsage(db, agent, conv);
    if (r.isFallback) {
      await emit([
        { type: 'failure', conversation_id: externalId, reason: `dialogflow fallback — no intent matched "${text.slice(0, 120)}"` },
      ]);
    }
    let sent = 0;
    for (const t of r.texts) {
      if (!t.trim()) continue;
      await emit([{ type: 'message_out', conversation_id: externalId, text: t, payload: { via: 'dialogflow', intent: r.intentName } }]);
      sent++;
    }
    for (const fb of r.fbPayloads) {
      const ok = await sendRawFbMessage(db, conv.id, fb);
      // payload.delivered tells ingest not to re-send the summary text —
      // even on failure, so "[rich message]" never leaks to the end user
      await emit([{ type: 'message_out', conversation_id: externalId, text: fbSummary(fb), payload: { via: 'dialogflow', delivered: true, intent: r.intentName } }]);
      if (ok) {
        sent++;
      } else {
        await emit([{ type: 'failure', conversation_id: externalId, reason: 'facebook send failed for dialogflow payload' }]);
      }
    }
    if (!sent) {
      await emit([{ type: 'failure', conversation_id: externalId, reason: 'empty dialogflow fulfillment' }]);
    }
  } catch (err) {
    await emit([
      { type: 'failure', conversation_id: externalId, reason: err instanceof Error ? err.message : 'dialogflow call failed' },
    ]);
  }
}
