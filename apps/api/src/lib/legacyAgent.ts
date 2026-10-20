import type { OutboundWebhook } from '@janis/shared';
import type { Db } from '../db/client.js';
import type { agents, conversations } from '../db/schema.js';
import { processEvents } from '../services/ingest.js';
import { loadSecretsMap } from './secrets.js';
import { detectIntent, type ServiceAccount } from './dialogflow.js';
import { sendRawFbMessage } from './channels.js';
import { reportLegacyUsage, isLegacyPaid } from './legacyBilling.js';
import { emitAlertEvent, emitInboundLine } from './slackClassic/emit.js';

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
  const text = event.text?.trim();
  if (!dfCfg?.project) {
    await emit([{ type: 'failure', conversation_id: externalId, reason: 'legacy bot missing dialogflow project' }]);
    if (text) emitInboundLine(db, agent, conv, text);
    return;
  }
  const secrets = await loadSecretsMap(db, agent.id);
  let sa: ServiceAccount | undefined;
  try {
    sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
  } catch {}
  if (!sa?.client_email || !sa.private_key) {
    await emit([{ type: 'failure', conversation_id: externalId, reason: 'legacy bot missing DIALOGFLOW_SA_JSON secret' }]);
    if (text) emitInboundLine(db, agent, conv, text);
    return;
  }
  if (!text) return;

  // paywall — same gate as the fallback path: inactive legacy sub → no DF call
  if (!(await isLegacyPaid(agent))) {
    // Verbatim: paused channels still transcribed. Paywalled bots did too —
    // the transcript line is observability, not a paid reply.
    emitInboundLine(db, agent, conv, text, { paused: conv.state === 'human' });
    return;
  }

  try {
    const r = await detectIntent(dfCfg.project, conv.id, text, dfCfg.lang ?? 'en', sa, [
      // hop.js apirequest — the janis context carries profile params DF
      // resolves in fulfillment text ("Hey #janis.first_name!").
      { name: 'janis', lifespan: 2, parameters: janisContextParams(conv) },
    ]);
    // 'chat message' rides the DF result verbatim (reply = v1 response JSON)
    // so the j-channel line can carry the training menu.
    const replyJson = r.raw ? JSON.stringify(r.raw) : undefined;
    emitInboundLine(db, agent, conv, text, {
      reply: replyJson,
      paused: conv.state === 'human',
    });
    // hop.js: isRequesting (assistance keywords + help_phrases − whitelist)
    // → 'live chat request message'; the member-side severity gates decide.
    if (requestsHuman(agent, text)) {
      emitAlertEvent(db, agent, conv, 'live chat request message', {
        text,
        reply: replyJson,
        help_requested: true,
      });
    }
    // hop.js: msg.custom_alert → 'custom alert message'. New-stack bots emit
    // for every matched intent — resolveAlertSettings +
    // applyCustomAlertIntentCheck suppress unless the member opted in.
    if (!r.isFallback && (r.intentName || r.action)) {
      emitAlertEvent(db, agent, conv, 'custom alert message', {
        text,
        reply: replyJson,
        custom_alert: true,
      });
    }
    if (r.isFallback) {
      emitAlertEvent(db, agent, conv, 'failure log', {
        isFailure: true,
        count: 1,
        message: text,
      });
    }
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
    emitAlertEvent(db, agent, conv, 'failure log', {
      isFailure: true,
      count: 1,
      message: text,
      error: err instanceof Error ? err.message : String(err),
    });
    await emit([
      { type: 'failure', conversation_id: externalId, reason: err instanceof Error ? err.message : 'dialogflow call failed' },
    ]);
  }
}

// The DF `janis` session context — fulfillment templates reference
// #janis.<param>. Legacy callers (ManyChat-era webhook payload, hop.js)
// seeded it from the Messenger profile; new-stack userProfile normalizes
// to the same field set.
function janisContextParams(conv: ConversationRow): Record<string, unknown> {
  const p = (conv.userProfile ?? {}) as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name : '';
  const [first, ...rest] = name.split(' ').filter(Boolean);
  return {
    id: p.id,
    name: p.name,
    first_name: p.first_name ?? (first || undefined),
    last_name: p.last_name ?? (rest.length ? rest.join(' ') : undefined),
    profile_pic: p.profile_pic ?? p.picture_url,
    gender: p.gender,
    locale: p.locale,
    timezone: p.timezone,
  };
}

// Common.assistanceRequestedPhrases + hop.js's help_phrases/whitelist merge.
const ASSISTANCE_PHRASES = ['start chat', 'human', 'help', 'operator', 'assistance', 'support'];

function requestsHuman(agent: AgentRow, text: string): boolean {
  const cfg = (agent.config ?? {}) as {
    use_human_keywords?: boolean;
    help_phrases?: string[];
    whitelist_phrases?: string[];
  };
  if (cfg.use_human_keywords === false) return false;
  const whitelist = (Array.isArray(cfg.whitelist_phrases) ? cfg.whitelist_phrases : []).map((p) =>
    p.toLowerCase(),
  );
  const phrases = ASSISTANCE_PHRASES.concat(
    (Array.isArray(cfg.help_phrases) ? cfg.help_phrases : []).map((p) => p.toLowerCase()),
  );
  const t = text.toLowerCase();
  return phrases.some((p) => t.includes(p) && !whitelist.includes(p));
}
