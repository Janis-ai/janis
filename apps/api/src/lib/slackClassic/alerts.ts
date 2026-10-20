// Port of showJanisAlert + the profile-card thread (slack_bot.js 7998-8680)
// and getChannelsAndShowAlert — the DM fan-out with per-member gates.

import type { ClassicChannelRow, ClassicConfig, ClassicCtx, Installation, LegacyEvent } from './types.js';
import {
  classicMembersFor,
  getClassicPrefs,
  setMemberDmChannel,
} from './store.js';
import { getTranscriptChannel } from './channels.js';
import { getBulkMessages } from './transcript.js';
import {
  applyCustomAlertIntentCheck,
  isPro,
  logSeverityFor,
  resolveAlertSettings,
  suppressionReason,
  type AlertType,
  type ClassicPrefsSettings,
} from './gates.js';
import { getUserProfile } from './profiles.js';
import {
  assistanceHeader,
  errorHeader,
  logHeader,
} from './strings.js';
import * as buttons from './buttons.js';

type Ctx = ClassicCtx;

const RECONNECT_CODES = new Set([102, 10, 190, 458, 459, 460, 463, 464, 467, 492]);
const FB_URL = (clientKey: string, userId: string | undefined, team: string, channelId?: string) =>
  `https://janis.ai/fb/?client_key=${clientKey}&user=${userId ?? ''}&team=${team}` +
  (channelId ? `&channel=${channelId}` : '');

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Header text per alert type (verbatim).
function headerText(type: AlertType, json: LegacyEvent, botName: string): string {
  const sentimentScore = json.docSentiment?.score ?? 0;
  if (type === 'showLog') {
    return logHeader(botName, logSeverityFor(json.count), sentimentScore, !!json.isFailure);
  }
  if (type === 'showCustomAlert') {
    let text = `:bell: *${botName}* Alert`;
    let reply: any = json.reply;
    if (typeof reply === 'string') {
      try {
        reply = JSON.parse(reply);
      } catch {
        reply = null;
      }
    }
    if (reply) {
      if (json.customAlertTitle) text = `:bell: *${botName}*: ${json.customAlertTitle}`;
      else if (reply.result?.metadata?.intentName) {
        text = `:bell: *${botName}*: ${reply.result.metadata.intentName}`;
      }
    }
    return text;
  }
  if (type === 'error') return errorHeader(botName);
  return assistanceHeader(botName);
}

// The red "said" attachment + error reconnect buttons (verbatim).
function saidAttachment(
  type: AlertType,
  json: LegacyEvent,
  userObject: { name?: string },
  install: Installation,
  channelId: string,
): any[] {
  const attachments: any[] = [];
  const userSaid = (json.text || json.message || '') as string;
  const mrkdwn = { mrkdwn_in: ['text', 'pretext'], color: '#ff0000' };
  if (json.type === 'out') {
    attachments.push({ ...mrkdwn, text: `*Bot said to ${userObject.name}*: ${userSaid}` });
  } else if (type === 'error') {
    if (json.error) {
      const err: any = json.error;
      let errorText = err.message ?? err;
      try {
        errorText = JSON.stringify(errorText, null, 2);
      } catch {
        /* keep */
      }
      attachments.push({ ...mrkdwn, text: `Error: ${errorText}` });
      const code = err.fbtrace_id ? err.code : undefined;
      const isOAuth = err.type === 'OAuthException' && err.code == null;
      const isPerm =
        code != null &&
        ((code >= 200 && code < 300) || RECONNECT_CODES.has(code));
      if (err.fbtrace_id && (isOAuth || isPerm)) {
        attachments.push(
          buttons.reconnectMessengerButtons(
            FB_URL(String(json.client_key), undefined, install.teamId, channelId),
          ),
        );
      }
    }
  } else {
    attachments.push({ ...mrkdwn, text: `*${userObject.name} said*: ${userSaid}` });
  }
  return attachments;
}

// Plan-dependent append (verbatim): trial ending, delinquent, basic, none.
function planAttachments(
  cfg: ClassicConfig,
  wordhopChannel: ClassicChannelRow | undefined,
  install: Installation,
  json: LegacyEvent,
  actionsAttachment: { text: string; callback_id: string; actions: any[] },
): any[] {
  const attachments: any[] = [];
  const subscription = cfg.subscription;
  const janisbot = (cfg.janisbot ?? {}) as { fb_app_id?: string; platform?: string };
  let transcriptLink: string | undefined;

  if (isPro(cfg)) {
    if (
      (janisbot.fb_app_id == null || janisbot.fb_app_id === '') &&
      janisbot.platform === 'messenger'
    ) {
      attachments.push(
        buttons.messengerLogButtons(
          FB_URL(String(json.client_key), undefined, install.teamId),
        ),
      );
    } else if (wordhopChannel) {
      const lastTs = wordhopChannel.lastMessageTs
        ? `/p${wordhopChannel.lastMessageTs.replace('.', '')}`
        : '';
      const domain =
        cfg.teamDomain ?? `${install.teamName ?? install.teamId}`;
      transcriptLink = `https://${domain}.slack.com/archives/${wordhopChannel.slackChannelId}${lastTs}`;
      attachments.push({
        mrkdwn_in: ['fields'],
        fields: [
          { short: false, value: `:speech_balloon: _See conversation_: ${transcriptLink}` },
        ],
      });
    }

    if (subscription?.status === 'trialing' && cfg.stripe_customer) {
      const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
      const diffDays = trialEnd ? Math.floor((trialEnd.getTime() - Date.now()) / 86400000) : 999;
      if (diffDays < 3) {
        const days = trialEnd
          ? diffDays === 0
            ? 'today'
            : diffDays === 1
              ? 'tomorrow'
              : `in ${diffDays} days`
          : 'soon';
        attachments.push({
          mrkdwn_in: ['fields'],
          fields: [
            {
              short: false,
              value: `:clock3: Your Janis Pro free trial will end *${days}*. You can always upgrade to Pro.`,
            },
          ],
        });
        actionsAttachment.actions.push(...(buttons.billingLogButtons().actions ?? []));
        actionsAttachment.actions.push(...(buttons.compareButtons().actions ?? []));
      }
    }
  } else if (
    subscription?.plan &&
    subscription.plan.id !== process.env.STRIPE_PLAN_BASIC &&
    cfg.stripe_customer?.delinquent === true
  ) {
    attachments.push({
      mrkdwn_in: ['fields'],
      fields: [
        {
          short: false,
          value:
            ':warning: Your payment could not be processed. Please update your billing information.',
        },
      ],
    });
    actionsAttachment.actions.push(...(buttons.billingLogButtons().actions ?? []));
  } else if (subscription?.plan && subscription.plan.id === process.env.STRIPE_PLAN_BASIC) {
    attachments.push({
      mrkdwn_in: ['fields'],
      fields: [
        {
          short: false,
          value:
            ':lock: Upgrade to process 1000+ messages with AI, more alerts, customer data, and human takeover.',
        },
      ],
    });
    actionsAttachment.actions.push(...(buttons.freePlanButtons().actions ?? []));
    actionsAttachment.actions.push(...(buttons.compareButtons().actions ?? []));
    actionsAttachment.actions.push(...(buttons.logButtons().actions ?? []));
  } else {
    attachments.push({
      mrkdwn_in: ['fields'],
      fields: [
        {
          short: false,
          value:
            ':no_entry: Your Janis Pro free trial ended. You can always upgrade to Pro. Not sure? Say `Plans` to compare.',
        },
      ],
    });
    actionsAttachment.actions.push(...(buttons.billingLogButtons().actions ?? []));
    actionsAttachment.actions.push(...(buttons.compareButtons().actions ?? []));
    actionsAttachment.actions.push(...(buttons.logButtons().actions ?? []));
  }
  return attachments;
}

// The threaded profile card (doProcessPro — verbatim field rules).
function profileCardAttachments(json: LegacyEvent, userObject: any, transcriptLink?: string) {
  const fields: { short: boolean; value: string }[] = [
    { short: false, value: `*Name*: ${userObject.name}` },
  ];
  if (transcriptLink) {
    fields.push({
      short: false,
      value: `:speech_balloon: *See conversation*: ${transcriptLink}`,
    });
  }
  const tags: { short: boolean; value: string }[] = [];
  const customFields: { short: boolean; value: string }[] = [];
  const attributes: { short: boolean; value: string }[] = [];

  const data = (json.user_profile as any)?.data ?? {};
  const profileFields = ['timezone', 'gender', 'locale', 'language', 'status', 'page_id', 'id'];
  const hidden = [
    'live_chat_url',
    'name',
    'first_name',
    'last_name',
    'last_input_text',
    'last name',
    'first name',
    'page_id',
  ];
  for (const [rawKey, item] of Object.entries(data)) {
    let i = rawKey;
    if (i === 'image') continue;
    if (i === 'tags' && Array.isArray(item)) {
      for (const tag of item) tags.push({ short: false, value: tag.name });
    } else if (i === 'custom_fields' && Array.isArray(item)) {
      for (const cf of item) {
        customFields.push({ short: false, value: `*${cf.name}*: ${cf.value}` });
      }
    } else if (!hidden.includes(i) && profileFields.includes(i) && item && item !== 'null' && item !== 'undefined') {
      i = i.replace('_', ' ');
      fields.push({ short: false, value: `*${capitalize(i)}*: ${item}` });
    } else if (!hidden.includes(i)) {
      i = i.replace('_', ' ');
      if (item && item !== 'null') {
        let itemtxt: string;
        if (i === 'incomingContexts') {
          try {
            const o = JSON.parse(item as string);
            itemtxt = '[\n' + Object.values(o).map((v) => JSON.stringify(v, null, 2)).join(',\n') + ',\n]';
          } catch {
            itemtxt = String(item);
          }
        } else {
          try {
            itemtxt = JSON.stringify(item, null, 2);
          } catch {
            itemtxt = String(item);
          }
        }
        attributes.push({ short: false, value: `*${i}*: ${itemtxt}` });
      }
    }
  }

  const attachments: any[] = [];
  if (userObject.image) attachments.push({ text: '', image_url: userObject.image });
  if (fields.length) attachments.push({ mrkdwn_in: ['fields'], fields });
  if (tags.length) attachments.push({ title: 'USER TAGS:', mrkdwn_in: ['fields'], color: '#7CD197', fields: tags });
  if (customFields.length) attachments.push({ title: 'CUSTOM FIELDS:', mrkdwn_in: ['fields'], color: '#FFA500', fields: customFields });
  if (attributes.length) attachments.push({ title: 'ATTRIBUTES:', mrkdwn_in: ['fields'], color: '#7CD197', fields: attributes });
  return attachments;
}

// One member's DM — the per-channel inner function of showJanisAlert.
async function showAlertToMember(
  ctx: Ctx,
  type: AlertType,
  json: LegacyEvent,
  member: {
    slackUserId: string;
    dmChannelId: string | null;
    prefs: { clientKey: string; settings: ClassicPrefsSettings }[];
  },
  wordhopChannel: ClassicChannelRow | null,
): Promise<void> {
  const cfg = ctx.install.classicConfig as ClassicConfig;
  const clientKey = String(json.client_key ?? '');

  // The DM channel doc equivalent: prefs rows keyed by client_key carry the
  // member's severities + intent subscriptions (the `custom_alerts` array).
  let dmChannelId = member.dmChannelId;
  if (!dmChannelId) {
    const opened = await ctx.api<{ channel?: { id?: string } }>(
      ctx.install.botToken,
      'conversations.open',
      { users: member.slackUserId },
    );
    dmChannelId = opened.ok && opened.channel?.id ? opened.channel.id : null;
    if (!dmChannelId) {
      ctx.result.suppressed.push({ channel: member.slackUserId, reason: 'no dm channel' });
      return;
    }
    await setMemberDmChannel(ctx.db, ctx.install.id, member.slackUserId, dmChannelId);
  }

  const ownPrefs =
    member.prefs.find((p) => p.clientKey === clientKey)?.settings ??
    (await getClassicPrefs(ctx.db, ctx.install.id, member.slackUserId, clientKey));
  const channelDoc = {
    ...ownPrefs,
    custom_alerts: member.prefs.map((p) => ({ ...p.settings, client_key: p.clientKey })),
  };
  const alertObj = resolveAlertSettings(channelDoc as any, clientKey);

  if (type === 'showCustomAlert' && (alertObj.customAlertSeverityLevel ?? 0) > 0) {
    alertObj.customAlertSeverityLevel = applyCustomAlertIntentCheck(
      alertObj.customAlertSeverityLevel!,
      alertObj,
      json.reply,
    );
  }

  const reason = suppressionReason(type, alertObj, json);
  if (reason) {
    ctx.result.suppressed.push({ channel: dmChannelId, reason });
    return;
  }

  const userObject = getUserProfile(json.user_profile ?? json);
  const botName = (json.botName ?? json.bot_name ?? '') as string;
  const attachments = saidAttachment(type, json, userObject, ctx.install, dmChannelId);
  const actionsAttachment = { text: ' ', callback_id: 'log_buttons', actions: [] as any[] };
  attachments.push(
    ...planAttachments(cfg, wordhopChannel ?? undefined, ctx.install, json, actionsAttachment),
  );
  if (actionsAttachment.actions.length > 0) attachments.push(actionsAttachment);

  const text = headerText(type, json, botName);
  const res = await ctx.say({
    channel: dmChannelId,
    text,
    attachments,
  });
  if (!res.ok || !res.ts) {
    ctx.result.errors.push(`alert dm ${dmChannelId}: ${res.error ?? 'skipped'}`);
    return;
  }
  ctx.result.posted.push({ channel: dmChannelId, ts: res.ts, kind: `alert:${type}` });

  // doProcessPro — threaded profile card under the alert DM.
  if (isPro(cfg) && res.message) {
    const domain = cfg.teamDomain ?? `${ctx.install.teamName ?? ctx.install.teamId}`;
    const transcriptLink = wordhopChannel
      ? `https://${domain}.slack.com/archives/${wordhopChannel.slackChannelId}${
          wordhopChannel.lastMessageTs ? `/p${wordhopChannel.lastMessageTs.replace('.', '')}` : ''
        }`
      : undefined;
    await ctx.api(ctx.install.botToken, 'chat.postMessage', {
      channel: dmChannelId,
      thread_ts: res.ts,
      text: ' ',
      attachments: profileCardAttachments(json, userObject, transcriptLink),
    });
  }
}

// showJanisAlert — verbatim: resolve j-channel (Pro only), then fan out to
// every member DM candidate with per-member gates.
export async function showJanisAlert(
  ctx: Ctx,
  type: AlertType,
  json: LegacyEvent,
): Promise<void> {
  if (!json.channel) {
    ctx.result.errors.push('alert missing channel');
    return;
  }
  const cfg = ctx.install.classicConfig as ClassicConfig;
  let wordhopChannel: ClassicChannelRow | null = null;
  if (isPro(cfg)) {
    wordhopChannel = await getTranscriptChannel({
      ...ctx,
      sourceChannel: String(json.channel ?? json.sourceChannel),
      clientKey: json.client_key as string | undefined,
      json,
      type,
      pro: true,
      isMessengerNoFb: ctx.isMessengerNoFb,
    });
  }
  const members = await classicMembersFor(ctx.db, ctx.install);
  if (members.length === 0) {
    ctx.result.suppressed.push({ channel: json.channel, reason: 'no slack-linked members' });
    return;
  }
  for (const member of members) {
    await showAlertToMember(ctx, type, json, member, wordhopChannel);
  }
}

// processMessageAndAlert — paused hard drop + per-team dispatch + the
// transcript-prelude flush (getBulkMessages runs BEFORE the fan-out,
// tolerating empty backlog).
export async function processMessageAndAlert(
  ctx: Ctx,
  type: AlertType,
  msg: LegacyEvent,
): Promise<void> {
  if (msg.paused) {
    ctx.result.suppressed.push({ channel: msg.channel, reason: 'paused' });
    return;
  }
  // Legacy flushes the transcript backlog first (getBulkMessages inside
  // getChannelsAndShowAlert); an empty backlog rejects but the alert still
  // fans out — same ordering preserved here.
  try {
    const backlog = await getBulkMessages(
      { ...ctx, result: ctx.result },
      msg,
    );
    if (backlog) {
      const { flushTranscript } = await import('./transcript.js');
      await flushTranscript({ ...ctx, result: ctx.result }, msg, backlog);
    }
  } catch {
    /* empty backlog — continue to alert */
  }
  await showJanisAlert(ctx, type, msg);
}
