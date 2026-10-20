// Port of the inbound half: incoming() + incomingContinued() + channelResponse()
// + sendMessageAsBot() + the slash_command handler (slack_bot.js 1867-2038,
// 5500-5560, 6071-6130, 9584-9900) and the DF-free interactive callbacks.
//
// DF-BOUNDARY: the j-channel conversational shell (transcript meta-bot via
// JANIS_TRANSCRIPT_BOT_CLIENT_KEY → apiaiResponse ~1200 lines) and the
// training-menu callbacks (training.js, 3151 lines) are a separate workstream —
// see docs/legacy-slack-parity.md Phase C. Everything reachable without the
// meta-bot is ported here verbatim.

import { and, eq, sql } from 'drizzle-orm';
import {
  conversations,
  slackClassicChannels,
  users,
} from '../../db/schema.js';
import { takeover, resume, humanReply } from '../../services/takeover.js';
import type { ClassicCtx } from './types.js';
import { slashCommandWarning } from './strings.js';
import { removeFormatting } from './profiles.js';
import { getClassicChannelBySlackId, resolveAgentDf, saveClassicChannel } from './store.js';
import { reconnectMessengerButtons } from './buttons.js';
import { openClassicDialog } from './dialogView.js';

const JANIS_WEBAPP = () => process.env.JANIS_WEBAPP_URL ?? 'https://www.janis.ai';

type Ctx = ClassicCtx;

export interface SlackInbound {
  team?: string | { id?: string };
  channel: string;
  user?: string;
  text?: string;
  ts?: string;
  type?: string;
  subtype?: string;
  files?: { url_private?: string; mimetype?: string; name?: string }[];
  callback_id?: string;
  command?: string;
  event?: string;
  trigger_id?: string;
  actions?: { value?: string; name?: string; selected_options?: { value?: string; text?: string }[] }[];
  original_message?: { thread_ts?: string; ts?: string; text?: string; attachments?: any[] };
  /** dialog_submission payload fields */
  submission?: Record<string, string>;
  response_url?: string;
  attachment_id?: number;
  /** set on click→incoming relay so button picks echo as user turns */
  callback_event?: string;
  sendToUser?: boolean;
  broadcast?: boolean;
  attachments?: any[];
  thread_ts?: string;
  /** app_mention / DM events → incoming() semantics (meta-bot), not ambient. */
  direct?: boolean;
  /** suggested_response Send — threads the reply at this customer ts. */
  replyts?: number;
  /** transcriptFunctions stamps the source-channel paused state on the msg. */
  paused?: boolean;
}

// ── incoming() — identity guards + channel resolution ───────────────────────

export async function classicIncoming(
  ctx: Ctx,
  message: SlackInbound,
): Promise<void> {
  const botUserId =
    (ctx.install.classicConfig as { botUserId?: string })?.botUserId ?? '';
  if (botUserId && message.user === botUserId) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'bot identity echo' });
    return;
  }
  if (message.user === 'USLACKBOT') {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'slackbot' });
    return;
  }
  if (message.callback_id === 'get_agents') {
    message.text = 'dialogflow';
    message.event = 'ListDialogflowAgents';
  }
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  await classicIncomingContinued(ctx, message, channel);
}

export async function classicIncomingContinued(
  ctx: Ctx,
  message: SlackInbound,
  channel: Awaited<ReturnType<typeof getClassicChannelBySlackId>> | null,
): Promise<void> {
  if (!channel) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'no channel' });
    return;
  }
  if (channel.isWordhopChannel || channel.isTrainingChannel) {
    const { channelTrainAmbient, trainingChannelIncoming } = await import('./trainingCallbacks.js');
    // @mention/DM events take incoming() directly (slack_bot.js 9611): the
    // meta-bot for wordhop channels, the customer-agent shell for training.
    if (message.direct) {
      if (channel.isWordhopChannel) {
        await transcriptChannelShell(ctx, message, channel);
      } else {
        await trainingChannelIncoming(ctx, message, channel);
      }
      return;
    }
    const botUserId = (ctx.install.classicConfig as { botUserId?: string })?.botUserId;
    if (botUserId && message.text?.includes(`<@${botUserId}>`)) {
      ctx.result.suppressed.push({
        channel: message.channel,
        reason: 'direct mention in ambient transcript/training channel',
      });
      return;
    }
    // verbatim ambient order (slack_bot.js 2243-2324):
    //   thread_ts && DF → channelTrain (+ meta-bot on callback replay)
    //   wordhop → callback_id ? incoming(meta-bot) : sendMessageAsBot(=channelResponse)
    //   training && !thread && !callback → incoming (customer-agent meta-bot)
    //   else → pause/resume hint
    if (message.thread_ts) {
      const trained = await channelTrainAmbient(ctx, message, channel);
      if (trained) {
        if (!channel.isTrainingChannel && message.callback_id) {
          await transcriptChannelShell(ctx, message, channel);
        }
        return;
      }
      // thread reply without DF creds falls through to the else-if chain
    }
    if (channel.isWordhopChannel) {
      if (message.callback_id === 'fb_buttons') return; // handled by callback path
      if (message.callback_id) {
        await transcriptChannelShell(ctx, message, channel);
      } else {
        await channelResponse(ctx, message, channel);
      }
      return;
    }
    if (channel.isTrainingChannel && !message.thread_ts && !message.callback_id) {
      await trainingChannelIncoming(ctx, message, channel);
      return;
    }
    if (message.text === 'pause' || message.text === 'resume') {
      await ctx.say({
        channel: message.channel,
        text: 'Are you trying to pause, or resume your bot?  Use `/pause` and `/resume` as commands.',
      });
      return;
    }
    ctx.result.suppressed.push({ channel: message.channel, reason: 'ambient no-match (j-channel)' });
    return;
  }
  // Non-j-channel Slack channel: the DM/broadcast shell (processIncoming) —
  // filter-by-reply + broadcast fan-out, ported below.
  await processIncomingClassic(ctx, message, channel);
}

// ── j-channel conversational shell (meta-bot) ──────────────────────────────
// Legacy routes every j-channel message through the transcript meta-bot's DF
// agent (contexts: transcript_channel + paused|resumed + transcribing +
// is_chatfuel/is_manychat/dialogflow_integration + has_*_token) then hands the
// result to apiaiResponse. We call detectIntentV1 directly when the meta-bot's
// service account is configured on the installation.

async function transcriptChannelShell(
  ctx: Ctx,
  message: SlackInbound,
  channel: NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>>,
): Promise<void> {
  // Verbatim (9613): fb_buttons clicks on transcript cards are dropped.
  if (message.callback_id === 'fb_buttons') return;

  // "Push Content" button → send_intent dialog (external data_source select)
  // unless the bot can't take it (no DF, or missing platform tokens) →
  // IntentPushFail meta-bot event (9623-9656).
  const matchingBot = channel.clientKey ? await resolveAgentDf(ctx, channel.clientKey) : null;
  const meta = channel.clientKey ? await agentMetaForKey(ctx, channel.clientKey) : {};
  if (message.trigger_id && message.actions?.[0]?.value === 'Push Content') {
    const isChatfuel = meta.is_chatfuel === true;
    const isManychat = meta.is_manychat === true;
    if (
      (!matchingBot && !meta.apiai_key) ||
      (isChatfuel && (!meta.chatfuel_token || !meta.chatfuel_botid)) ||
      (isManychat && !meta.manychat_token)
    ) {
      const { sendIntentForTranscriptBot } = await import('./adminActions.js');
      await sendIntentForTranscriptBot(
        ctx,
        { channel: message.channel, isTranscriptChannel: true },
        channel,
        null,
        { name: 'IntentPushFail', data: {} },
        meta,
      );
      return;
    }
    const dialog = {
      callback_id: 'send_intent',
      title: 'Push Bot Content',
      submit_label: 'Push',
      notify_on_cancel: false,
      elements: [
        {
          label: 'Dialogflow Intents',
          type: 'select',
          name: 'intent_id',
          value: 'Intent Selection',
          placeholder: 'Search for your intent',
          data_source: 'external',
        },
      ],
    };
    await openClassicDialog(ctx, {
      triggerId: message.trigger_id,
      dialog,
      channel: message.channel,
      user: message.user,
    });
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'dialog:send_intent' });
    return;
  }

  const cfg = ctx.install.classicConfig as {
    transcriptBotSa?: { client_email: string; private_key: string; project_id: string };
    transcriptBotLang?: string;
  };
  // Resolve the meta-bot SA: explicit classicConfig first, else the
  // JANIS_TRANSCRIPT_BOT_CLIENT_KEY agent's own DIALOGFLOW_SA_JSON secret —
  // same identity legacy uses.
  let transcriptBotSa = cfg.transcriptBotSa;
  let transcriptBotLang = cfg.transcriptBotLang;
  if (!transcriptBotSa?.client_email) {
    const resolved = await resolveTranscriptBot(ctx);
    transcriptBotSa = resolved?.sa;
    transcriptBotLang = transcriptBotLang ?? resolved?.lang;
  }
  if (!transcriptBotSa?.client_email) {
    ctx.result.suppressed.push({
      channel: message.channel,
      reason: 'transcript meta-bot not configured',
    });
    return;
  }

  // Verbatim context set (slack_bot.js 9696-9745).
  const contexts: { name: string; lifespan: number }[] = [
    { name: 'transcript_channel', lifespan: 1 },
  ];
  const sourceConv = await conversationForSource(ctx, channel.sourceChannel);
  if (sourceConv?.state === 'human' || channel.paused) {
    contexts.push({ name: 'paused', lifespan: 1 });
  } else {
    contexts.push({ name: 'resumed', lifespan: 1 });
  }
  if (channel.shouldProcessTranscript) {
    contexts.push({ name: 'transcribing', lifespan: 1 });
  }
  // Verbatim platform-flag contexts (9696-9718).
  if (meta.is_chatfuel === true) {
    contexts.push({ name: 'is_chatfuel', lifespan: 1 });
    if (meta.chatfuel_token) contexts.push({ name: 'has_chatfuel_token', lifespan: 1 });
    if (meta.chatfuel_botid) contexts.push({ name: 'has_chatfuel_botid', lifespan: 1 });
  } else if (meta.is_manychat === true) {
    contexts.push({ name: 'is_manychat', lifespan: 1 });
    if (meta.manychat_token) contexts.push({ name: 'has_manychat_token', lifespan: 1 });
  } else if (meta.code_lang === 'dialogflow') {
    contexts.push({ name: 'dialogflow_integration', lifespan: 1 });
  }

  let body: any;
  try {
    const { detectIntentV1 } = await import('../dialogflow.js');
    body = await detectIntentV1(
      transcriptBotSa.project_id,
      message.channel,
      {
        text: message.text ?? undefined,
        event: message.event ? { name: message.event, data: {} } : undefined,
        contexts,
        lang: transcriptBotLang ?? channel.lang ?? 'en',
      } as any,
      transcriptBotSa as any,
    );
  } catch (e) {
    ctx.result.errors.push(`meta-bot query: ${String(e)}`);
    return;
  }

  await classicApiAiResponse(ctx, message, body, channel);
}

// resolveTranscriptBot — the meta-bot SA creds, read from the designated
// agent's secrets + dialogflow config. Two legacy meta-bots: the j-channel
// transcript bot (JANIS_TRANSCRIPT_BOT_CLIENT_KEY) and the DM/wordhop shell
// (WORDHOP_CLIENT_KEY); each falls back to the other when unset.
export async function resolveTranscriptBot(
  ctx: Ctx,
  kind: 'transcript' | 'wordhop' = 'transcript',
): Promise<{ sa: { client_email: string; private_key: string; project_id: string }; lang?: string } | null> {
  const primary =
    kind === 'wordhop' ? process.env.WORDHOP_CLIENT_KEY : process.env.JANIS_TRANSCRIPT_BOT_CLIENT_KEY;
  const fallback =
    kind === 'wordhop' ? process.env.JANIS_TRANSCRIPT_BOT_CLIENT_KEY : process.env.WORDHOP_CLIENT_KEY;
  const clientKey = primary || fallback;
  if (!clientKey) return null;
  const { agents } = await import('../../db/schema.js');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  if (!agent) return null;
  const { loadSecretsMap } = await import('../secrets.js');
  const secrets = await loadSecretsMap(ctx.db, agent.id);
  let sa: any;
  try {
    sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
  } catch {
    return null;
  }
  if (!sa?.client_email || !sa?.private_key || !sa?.project_id) return null;
  const cfg = (agent.config ?? {}) as { dialogflow?: { lang?: string } };
  return { sa, lang: cfg.dialogflow?.lang };
}

// classicApiAiResponse — apiaiResponse (slack_bot.js 10889-11927) verbatim
// action dispatch, in legacy order-of-appearance. Fulfillment always renders
// through makeMessageFromApiAi first; every action then either performs its
// port + sends `data`, or records a suppressed reason so shadow diffs
// surface the unported remainder. The tail (detectEventAndSend) re-detects
// params.event on the meta-bot and recurses.
export async function classicApiAiResponse(
  ctx: Ctx,
  message: SlackInbound,
  body: any,
  channel: NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>>,
  extraContexts: any[] = [],
): Promise<void> {
  const action = body?.result?.action;
  const params = body?.result?.parameters ?? {};
  const result = body?.result ?? {};

  const { makeMessageFromApiAi } = await import('./dfRender.js');
  const {
    botObjsForWorkspace, botSettingsMessage, getBotAlertSettings, inviteMemberToIm,
    manageIntents, saveBotContext, suggestBotMessage, INVITE_USER_NOT_FOUND,
  } = await import('./adminActions.js');
  const {
    DM_SENTINEL, getClassicPrefs, setMemberDocSettings,
  } = await import('./store.js');
  const { detectIntentV1 } = await import('../dialogflow.js');

  // data = makeMessageFromApiAi(response) — the verbatim fulfillment render.
  const data = makeMessageFromApiAi(body, false, channel.isWordhopChannel);
  const text = data.text;
  const say = async (msg: any, attachments?: any[]) => {
    const payload = typeof msg === 'string' ? { text: msg } : msg;
    if (payload.channel == null) payload.channel = message.channel;
    if (payload.text == null && payload.attachments == null && attachments != null) {
      payload.attachments = attachments;
    }
    const res = await ctx.say(payload);
    ctx.result.posted.push({ channel: payload.channel, ts: res.ts ?? '', kind: 'meta-bot' });
  };
  const sayInThread = async (msg: any) => {
    const payload = { ...msg, channel: message.channel, thread_ts: message.ts };
    const res = await ctx.say(payload);
    ctx.result.posted.push({ channel: message.channel, ts: res.ts ?? '', kind: 'meta-bot' });
  };

  // state — verbatim session state: clone(stateDefault) overlaid with the
  // matching keys on the DM doc (the channel doc for DM traffic), then the
  // filterSettings keys, then params merged in (10730-10766). The doc itself
  // carries custom_alerts + severities outside `state`.
  const STATE_DEFAULTS = {
    id: '', bot_name: '', broadcasting: false, code_language: '',
    does_not_use_apiai: true, failure: '', failures: [] as any[],
    filtertype: '', framework: '', last_source_channel: '', page: 0,
    pagination: '', platform: '', 'start-doesnothavebot-followup': false,
    'start-hasbot-followup': false, uses_apiai: false, bot_context: {} as any,
  };
  const FILTER_KEYS = [
    'helpNeededSeverityLevel', 'logSeverityLevel', 'userUpsetSeverityLevel',
    'errorWarningLevel', 'customAlertSeverityLevel', 'intents',
  ];
  const userId = message.user ?? '';
  const settings: any = userId
    ? await getClassicPrefs(ctx.db, ctx.install.id, userId, DM_SENTINEL)
    : {};
  const state: any = JSON.parse(JSON.stringify(STATE_DEFAULTS));
  for (const key of Object.keys(state)) {
    if (settings[key] != null) state[key] = settings[key];
  }
  for (const key of FILTER_KEYS) {
    if (settings[key] != null) state[key] = settings[key];
  }
  const botObjs = await botObjsForWorkspace(ctx);
  const clientKey =
    (settings.bot_context as { client_key?: string } | undefined)?.client_key ??
    channel.clientKey ??
    '';

  // matchingBot — botObjs entry matching the doc's bot_name, enriched with
  // the agent's dialogflow/locale/is_* metadata (legacy bot doc fields).
  const matchingBotRow = clientKey ? await resolveAgentDf(ctx, clientKey) : null;
  const matchingAgentMeta = (matchingBotRow?.agent?.metadata ?? {}) as Record<string, unknown>;
  const matchingAgentCfg = (matchingBotRow?.agent?.config ?? {}) as Record<string, any>;
  const matchingBot: any = botObjs.find((o) => o.name === settings.bot_name) ?? {
    name: settings.bot_name ?? 'All bots',
    client_key: clientKey || undefined,
  };
  if (clientKey && !matchingBot.client_key) matchingBot.client_key = clientKey;
  if (matchingAgentCfg.dialogflow?.project) {
    matchingBot.dialogflow = {
      agent_object: { defaultLanguageCode: matchingAgentCfg.dialogflow.lang ?? 'en' },
    };
    matchingBot.apiai_key = 'df';
  }
  matchingBot.is_chatfuel = matchingAgentMeta.is_chatfuel;
  matchingBot.is_manychat = matchingAgentMeta.is_manychat;
  if (matchingAgentMeta.locale) matchingBot.locale = matchingAgentMeta.locale;

  // ── params → state merge (10730-10766) + reset_bot context (10769-10780) ──
  if (params.bot_name && params.bot_name !== '') {
    state.bot_name = params.bot_name;
    saveBotContext(botObjs, state);
  }
  if (params.framework && params.framework !== '') state.framework = params.framework;
  if (params['date-range'] && params['date-range'] !== '') state.date_range = params['date-range'];
  if (params.date_range_in_log && params.date_range_in_log !== '') {
    state.date_range_in_log = params.date_range_in_log;
  }
  if (params.source_channel && params.source_channel !== '') {
    state.last_source_channel = params.source_channel;
  }
  if (params.filtertype && params.filtertype !== '') {
    state.filtertype = String(params.filtertype).toLowerCase();
  }
  if (params.code_language && params.code_language !== '') {
    state.code_language = params.code_language;
  }
  if (params.platform && params.platform !== '') state.platform = params.platform;
  for (const c of result.contexts ?? []) {
    if (c?.name === 'reset_bot') {
      const stateid = state.id;
      const fresh = JSON.parse(JSON.stringify(STATE_DEFAULTS));
      delete fresh.custom_alerts;
      fresh.id = stateid;
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, fresh);
      delete settings.shell;
    }
  }

  const saveDoc = () => setMemberDocSettings(ctx.db, ctx.install.id, userId, settings);
  const saveState = () =>
    setMemberDocSettings(ctx.db, ctx.install.id, userId, { ...settings, ...state });

  // re-detect + recurse — the detectEventAndSend tail and the event-driven
  // re-entry points (bot.name.confirm, waitlist.join).
  const reDetect = async (query: { event?: { name: string; data?: any }; userSays?: string; contexts?: any[] }) => {
    const tb = await resolveTranscriptBot(ctx);
    if (!tb) {
      ctx.result.suppressed.push({ channel: message.channel, reason: 're-detect: no meta-bot creds' });
      return;
    }
    const res = await detectIntentV1(
      tb.sa.project_id,
      message.user ?? message.channel,
      {
        ...(query.event ? { event: query.event } : {}),
        ...(query.userSays != null ? { text: query.userSays } : {}),
        contexts: query.contexts ?? extraContexts,
        lang: tb.lang ?? 'en',
      } as any,
      tb.sa,
    );
    if (res) await classicApiAiResponse(ctx, message, res, channel, query.contexts ?? extraContexts);
  };

  // ── action dispatch — legacy order ───────────────────────────────────────

  if (action === 'log_unknown_intent' || action === 'input.unknown') {
    // logUnkownIntent(bot, message, data) → sendMessage(data) — the rendered
    // fulfillment object verbatim (empty renders drop silently in sendMessage).
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'add_apiai_key' && params.apiai_key) {
    // wordhopapi.addApiAiKey — persist the DF key on the bot doc.
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (agent) {
      await ctx.db
        .update(agents)
        .set({ metadata: { ...(agent.metadata as Record<string, unknown>), apiai_key: params.apiai_key } })
        .where(eq(agents.id, agent.id));
      await say(data);
    } else {
      await say({ text: 'There was a problem saving your key. Please try again.', attachments: [] });
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'subscriptions.news.send') {
    // Legacy latches state.broadcasting on the doc — persisted by the tail's
    // channels.save(state) → saveState(). The next typed message fans out.
    state.broadcasting = true;
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'intents.manage.help.bot' || action === 'intents.manage') {
    const options: any = {
      client_key: matchingBot.client_key,
      apiai_key: matchingBot.apiai_key,
      bot_name: matchingBot.name,
      is_chatfuel: matchingBot.is_chatfuel,
      is_manychat: matchingBot.is_manychat,
    };
    if (matchingBot.dialogflow?.agent_object?.defaultLanguageCode) {
      options.lang = matchingBot.dialogflow.agent_object.defaultLanguageCode;
    }
    if (matchingBot.locale) options.lang = matchingBot.locale;
    const botName = settings.bot_name ?? matchingBot.name;
    const trainingChannel = await manageIntents(ctx, { channel: message.channel, user: message.user }, options, botName);
    if (trainingChannel) {
      if (action === 'intents.manage.help.bot' && typeof data.text === 'string') {
        data.text = data.text.replace('training_channel_link', ` <#${trainingChannel.id}>`);
        for (const att of data.attachments ?? []) {
          if (att.text) att.text = String(att.text).replace('training_channel_link', ` <#${trainingChannel.id}>`);
          if (att.title) att.title = String(att.title).replace('training_channel_link', ` <#${trainingChannel.id}>`);
          for (const f of att.fields ?? []) {
            if (f.value) f.value = String(f.value).replace('training_channel_link', ` <#${trainingChannel.id}>`);
          }
        }
      } else if (action === 'intents.manage') {
        data.text = `${data.text ?? ''} <#${trainingChannel.id}>`;
      }
      await say(data);
    } else {
      ctx.result.suppressed.push({ channel: message.channel, reason: 'manageIntents: channel create failed' });
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'help.no_response.no_bot' && params.bot_name && params.bot_name !== '') {
    // params→state already merged bot_name above; verbatim re-asserts +
    // persists the doc.
    state.bot_name = params.bot_name;
    saveBotContext(botObjs, state);
    await saveState();
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.add.init' || action === 'bot.context.set') {
    // state = clone(stateDefault), custom_alerts deleted (a no-op — it never
    // lives on state), id kept, doc re-saved in the tail.
    const fresh = JSON.parse(JSON.stringify(STATE_DEFAULTS));
    delete fresh.custom_alerts;
    fresh.id = state.id;
    if (action === 'bot.context.set' && params.bot_name && params.bot_name !== '') {
      fresh.bot_name = params.bot_name;
      saveBotContext(botObjs, fresh);
    }
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);
    delete settings.shell;
    await saveState();
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'dialogflow.agents.get' || action === 'agent.name.save') {
    // Requires the member's Google OAuth link (slack_integration.google) —
    // not migrated to the new stack.
    await say(data.text || data);
    ctx.result.suppressed.push({
      channel: message.channel,
      reason: `meta-bot action unported: ${action} (user Google OAuth link)`,
    });
    await maybeReDetectEvent();
    return;
  }

  if (action === 'dashbot.key.save' && params.key) {
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (agent) {
      await ctx.db
        .update(agents)
        .set({ metadata: { ...(agent.metadata as Record<string, unknown>), dashbot_key: params.key } })
        .where(eq(agents.id, agent.id));
      await say(data);
    } else {
      await say({ text: 'There was a problem saving your Dashbot key. Please try again.', attachments: [] });
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.name.confirm' && params.bot_name) {
    // Legacy re-enters incoming() with a ConfirmBotname event.
    await reDetect({
      event: {
        name: 'ConfirmBotname',
        data: {
          bot_name: params.bot_name,
          agent_value: params.agent_value,
          selected_option: params.selected_option,
        },
      },
    });
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.name.change' && params.bot_name && params.trigger_id) {
    const dialog = {
      callback_id: 'bot_name',
      title: 'Bot name',
      submit_label: 'Save',
      notify_on_cancel: true,
      elements: [
        {
          type: 'text',
          label: 'Name',
          name: 'bot_name',
          min_length: 4,
          value: '',
          placeholder: 'Type the name of your bot',
        },
      ],
    };
    const res = await openClassicDialog(ctx, {
      triggerId: params.trigger_id,
      dialog,
      channel: message.channel,
      user: message.user,
    });
    if (!res) await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.name.save' && params.bot_name) {
    const isBotExisting = botObjs.some((o) => o.name === params.bot_name);
    const agentValue = params.agent_value;
    const selectedOption = params.selected_option;
    if (!isBotExisting || (agentValue && selectedOption)) {
      if (agentValue && selectedOption) {
        // addDialogflowAgent — requires the member's Google OAuth link.
        ctx.result.suppressed.push({
          channel: message.channel,
          reason: 'bot.name.save: addDialogflowAgent needs user Google OAuth link',
        });
      }
      // wordhopapi.addBot → create the local agent + client_key, then set
      // the doc's bot_context/bot_name + default severities (all 1s).
      const { agents } = await import('../../db/schema.js');
      const { randomBytes } = await import('crypto');
      const newKey = randomBytes(12).toString('hex');
      const [created] = await ctx.db
        .insert(agents)
        .values({
          workspaceId: ctx.install.workspaceId,
          name: String(params.bot_name),
          metadata: { legacy_client_key: newKey },
        })
        .returning();
      const botAlertSettings = getBotAlertSettings(settings, newKey);
      botAlertSettings.logSeverityLevel = 1;
      botAlertSettings.userUpsetSeverityLevel = 1;
      botAlertSettings.helpNeededSeverityLevel = 1;
      botAlertSettings.errorWarningLevel = 1;
      botAlertSettings.customAlertSeverityLevel = 1;
      const botContext = { name: created.name, client_key: newKey };
      botObjs.push(botContext);
      state.bot_name = created.name;
      state.bot_context = botContext;
      await saveDoc();
      await saveState();
    }
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'plans.subscribe') {
    // wordhopapi.setPlan — Stripe checkout/billing lives on the new console;
    // legacy plan ids (STRIPE_PLAN_*) don't exist here.
    ctx.result.suppressed.push({ channel: message.channel, reason: 'meta-bot action unported: plans.subscribe (billing console)' });
    await say(data.text || data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'code.language.set' || action === 'code.platform.set') {
    // wordhopapi.updateBot(client_key, user, {...}) → agent metadata fields.
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (agent) {
      const meta = { ...(agent.metadata as Record<string, unknown>) };
      if (action === 'code.language.set') {
        meta.code_language = state.code_language;
        if (['dialogflow', 'chatfuel', 'manychat'].includes(state.code_language)) {
          meta.platform = 'messenger';
        }
      } else {
        meta.platform = state.platform;
      }
      await ctx.db.update(agents).set({ metadata: meta }).where(eq(agents.id, agent.id));
      saveBotContext(botObjs, settings);
    }
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.getAll' || action === 'training_channel.requested.no_bot') {
    await say(suggestBotMessage(text ?? '', botObjs));
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.settings' || action === 'filter') {
    // replyInThread(botSettingsMessage(..., doSave=true)) — settings doc
    // mutations (custom_alerts defaults) persist.
    const msg = botSettingsMessage(botObjs, matchingBot, 0, 0, settings);
    await saveDoc();
    await sayInThread(msg);
    if (action === 'filter') {
      await say(
        'Click on the `1 reply` link just above and I\'ll help you manage your alerts. ' +
          'If you want to troubleshoot alerts, or learn some tips and tricks for managing alerts in Slack, say `Help with alerts`.',
      );
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'bot.automation.toggle.enable' || action === 'bot.automation.toggle.disable') {
    // wordhopapi.toggleBotStatus(client_key, user, enabled) → agent flag.
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (agent) {
      await ctx.db
        .update(agents)
        .set({
          metadata: {
            ...(agent.metadata as Record<string, unknown>),
            automation_enabled: action === 'bot.automation.toggle.enable',
          },
        })
        .where(eq(agents.id, agent.id));
    }
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'resume_bot') {
    const source = params.source_channel;
    if (!source || source === 'xxxxxx' || source === '') {
      await say('Please click on the `Resume Bot` button above to activate your bot for this user.');
    } else {
      const { takeOverButtons } = await import('./buttons.js');
      await say({ text, attachments: [takeOverButtons(source)] });
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'developer.added' || action === 'member.added') {
    const username = params.username;
    const invited = username ? await inviteMemberToIm(ctx, String(username), userId, botObjs) : null;
    if (invited) {
      await say({
        text: `:+1: I just invited ${invited.name} and will tell them how to complete the setup. It only takes minutes and begins working immediately.`,
        attachments: [
          {
            title: 'While you wait…',
            text: `Don't want to wait for ${invited.name} to integrate me?  Here are things you can do right away`,
            mrkdwn_in: ['fields'],
            fields: [
              {
                short: false,
                value:
                  ':mortar_board: `Start Training` Simulate automated conversations in a dedicated Slack channel. Define and manage intents, what users say, and your responses.',
              },
            ],
            callback_id: 'generic_callback',
            actions: [
              { name: 'Start Training', text: 'Start Training', type: 'button', value: 'Start Training' },
              { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
            ],
          },
        ],
      });
    } else {
      await say(INVITE_USER_NOT_FOUND);
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'context.clear') {
    // state reset (id kept), doc saved, then a `user` context primes the
    // next query — pushed onto myContexts for the detectEventAndSend tail.
    const fresh = JSON.parse(JSON.stringify(STATE_DEFAULTS));
    delete fresh.custom_alerts;
    fresh.id = state.id;
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);
    delete settings.shell;
    await saveState();
    try {
      const ures = await ctx.api<{ user?: any }>(ctx.install.botToken, 'users.info', { user: userId });
      extraContexts.push({
        name: 'user',
        lifespan: 5,
        parameters: {
          name: ures.user?.name,
          teamName: (ctx.install.classicConfig as any)?.teamDomain,
        },
      });
    } catch {
      // legacy logs the error on the team doc and resolves — non-fatal
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'waitlist.join' && userId) {
    const ures = await ctx.api<{ user?: { profile?: { email?: string } } }>(ctx.install.botToken, 'users.info', {
      user: userId,
    });
    const email = ures.user?.profile?.email;
    if (email) {
      const userContext = { name: 'user_email', lifespan: 5, parameters: { email } };
      await reDetect({ userSays: email, contexts: [userContext] });
    } else {
      await say(data);
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'email.add') {
    // wordhopapi.addEmail + Untorch.submitSignup — referral service retired.
    await say(data.text || data);
    ctx.result.suppressed.push({ channel: message.channel, reason: 'meta-bot action unported: email.add (Untorch retired)' });
    await maybeReDetectEvent();
    return;
  }

  if (action === 'transcript_help') {
    const { pauseResumeButtons } = await import('./buttons.js');
    const conv = await conversationForSource(ctx, channel.sourceChannel);
    const buttons = pauseResumeButtons({ paused: conv?.state === 'human' || channel.paused });
    data.attachments = [...(data.attachments ?? []), buttons];
    await say(data);
    await maybeReDetectEvent();
    return;
  }

  if (action === 'skip_fb' || action === 'starter_kit' || action?.startsWith('settings.show')) {
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (action === 'skip_fb') {
      if (agent) {
        await ctx.db
          .update(agents)
          .set({ metadata: { ...(agent.metadata as Record<string, unknown>), skip_fb: true } })
          .where(eq(agents.id, agent.id));
        await say(data);
      } else {
        await say('Whoops! something went wrong. Please try again.');
      }
    } else if (action === 'starter_kit' && params['zip-url'] && agent) {
      try {
        const df = await resolveAgentDf(ctx, clientKey);
        if (!df) throw new Error('no df creds');
        const zipRes = await fetch(String(params['zip-url']));
        if (!zipRes.ok) throw new Error(`zip fetch ${zipRes.status}`);
        const zipB64 = Buffer.from(await zipRes.arrayBuffer()).toString('base64');
        const { restoreAgentV2 } = await import('../dialogflow.js');
        await restoreAgentV2(df.project, zipB64, df.sa);
        await ctx.db
          .update(agents)
          .set({
            metadata: {
              ...(agent.metadata as Record<string, unknown>),
              dialogflow_template: params['zip-url'],
              settings_shown: true,
            },
          })
          .where(eq(agents.id, agent.id));
        await say(data);
      } catch (e) {
        let errorMessage = 'Whoops! something went wrong. Please try again.';
        try {
          const parsed = JSON.parse((e as Error).message);
          if (parsed?.error?.message) errorMessage = parsed.error.message;
          else if (parsed?.error) errorMessage = parsed.error;
        } catch {
          if ((e as Error).message) errorMessage = (e as Error).message;
        }
        await say({
          text: errorMessage,
          attachments: [
            {
              text: '',
              attachment_type: 'default',
              actions: [
                { name: 'Install', type: 'button', value: 'Install', text: 'Install' },
                { name: 'Cancel', type: 'button', value: 'Cancel', text: 'Cancel' },
              ],
              callback_id: 'generic_callback',
            },
          ],
        });
      }
    } else if (action?.startsWith('settings.show') && action !== 'settings.show.messenger' && agent) {
      await ctx.db
        .update(agents)
        .set({ metadata: { ...(agent.metadata as Record<string, unknown>), settings_shown: true } })
        .where(eq(agents.id, agent.id));
      await say(data);
    } else {
      await say(data.text || data);
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'create_dialogflow_agent') {
    if (message.trigger_id == null) {
      await say(data);
    } else {
      const dialog = {
        callback_id: 'agent_name',
        title: 'Dialogflow agent',
        submit_label: 'Create',
        notify_on_cancel: true,
        elements: [
          {
            type: 'text',
            label: 'Name',
            name: 'agent_name',
            min_length: 4,
            value: '',
            placeholder: 'Type the name of your agent',
          },
        ],
      };
      await openClassicDialog(ctx, {
        triggerId: message.trigger_id,
        dialog,
        channel: message.channel,
        user: message.user,
      });
    }
    await maybeReDetectEvent();
    return;
  }

  if (action === 'block_push' && params.blockname) {
    const blocks = String(params.blockname).split(',').map((s) => s.trim());
    await redirectToCustomer(ctx, channel, { redirect_to_blocks: blocks }, message);
    await maybeReDetectEvent();
    return;
  }
  if (action === 'set_attributes' && params.attribute_name && params.attribute_value != null) {
    await redirectToCustomer(ctx, channel, {
      set_attributes: { [params.attribute_name]: params.attribute_value },
    }, message);
    await maybeReDetectEvent();
    return;
  }
  if (action === 'flow_push' && params.flowid) {
    await redirectToCustomer(ctx, channel, { flow: [params.flowid] }, message);
    await maybeReDetectEvent();
    return;
  }

  // ── legacy tail: fulfillment renders; no-messages → logUnkownIntent ──────
  if (result.fulfillment?.messages != null || data.text || data.attachments?.length) {
    if (data.text || data.attachments?.length) await say(data.text || ' ', data.attachments);
  } else {
    await say(" OK got it! I've passed that message on to the Janis team.");
  }
  if (action) {
    ctx.result.suppressed.push({ channel: message.channel, reason: `meta-bot action unported: ${action}` });
  }

  async function maybeReDetectEvent() {
    // Legacy tail (11871-11875): channels.save(state) runs after EVERY
    // action branch resolves, then detectEventAndSend — params.event
    // (+eventparam_*) re-detects on the meta-bot and recurses apiaiResponse.
    if (userId) await saveState();
    if (!params.event) return;
    const event: { name: string; data?: Record<string, unknown> } = { name: params.event };
    for (const p of Object.keys(params)) {
      if (p.startsWith('eventparam_')) {
        event.data = event.data ?? {};
        event.data[p.substring(11)] = params[p];
      }
    }
    await reDetect({ event });
  }
}

// agentMetaForKey — the raw agent.metadata bag for a legacy client_key.
async function agentMetaForKey(ctx: Ctx, clientKey: string): Promise<Record<string, unknown>> {
  const { agents } = await import('../../db/schema.js');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  return (agent?.metadata ?? {}) as Record<string, unknown>;
}

async function agentPlatformFlags(
  ctx: Ctx,
  clientKey: string,
): Promise<{ contexts: string[] }> {
  const { agents } = await import('../../db/schema.js');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
  const contexts: string[] = [];
  if (meta.is_chatfuel) {
    contexts.push('is_chatfuel');
    if (meta.chatfuel_token) contexts.push('has_chatfuel_token');
    if (meta.chatfuel_botid) contexts.push('has_chatfuel_botid');
  } else if (meta.is_manychat) {
    contexts.push('is_manychat');
    if (meta.manychat_token) contexts.push('has_manychat_token');
  } else if (meta.code_lang === 'dialogflow' || meta.dialogflow) {
    contexts.push('dialogflow_integration');
  }
  return { contexts };
}

// redirectToBlocks (slack_bot.js 12699-12916) — the platform payload send.
// Chatfuel: POST api.chatfuel.com/bots/{botid}/users/{psid}/send?chatfuel_
// token=…&chatfuel_block_name={block}{&k=v attrs} per block — verbatim quirk:
// the set_attributes query string is consumed by the FIRST block's URL only
// (legacy clears it inside the task-build loop). Attribute-only sends hit
// block_name=Janis with the stray "user input=" key. set_attributes also
// merges into the customer user doc's `data` JSON after the sends.
// ManyChat: POST api.manychat.com/fb/sending/sendFlow {subscriber_id,flow_ns}.
// Missing token/botid on a wordhop channel → IntentPushFail meta-bot card.
// Non-wordhop channels only return the training text (caller-side no-op).
async function redirectToCustomer(
  ctx: Ctx,
  channel: { sourceChannel: string; clientKey: string | null; isWordhopChannel?: boolean },
  payload: Record<string, unknown>,
  message: SlackInbound,
): Promise<void> {
  if (!channel.clientKey) return;
  const { agents } = await import('../../db/schema.js');
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${channel.clientKey}`)
    .limit(1);
  const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
  const matchingBot = {
    is_chatfuel: meta.is_chatfuel === true,
    is_manychat: meta.is_manychat === true,
    chatfuel_token: meta.chatfuel_token as string | undefined,
    chatfuel_botid: meta.chatfuel_botid as string | undefined,
    manychat_token: meta.manychat_token as string | undefined,
  };
  const messages = [{ type: 4, payload }];
  const userid = channel.sourceChannel;

  const pushFail = async () => {
    const { sendIntentForTranscriptBot } = await import('./adminActions.js');
    await sendIntentForTranscriptBot(
      ctx,
      { channel: message.channel, isTranscriptChannel: true },
      { clientKey: channel.clientKey, name: (agent?.name ?? undefined) as string | undefined },
      null,
      { name: 'IntentPushFail', data: {} },
      meta,
    );
  };

  const platformPost = async (provider: string, url: string, init?: RequestInit) => {
    if (ctx.dry) {
      ctx.result.posted.push({
        channel: message.channel,
        ts: '',
        kind: 'platform-redirect',
        payload: { provider, url },
      });
      return true;
    }
    const res = await fetch(url, { method: 'POST', ...(init ?? {}) }).catch(() => null);
    ctx.result.posted.push({
      channel: message.channel,
      ts: '',
      kind: 'platform-redirect',
      payload: { provider, url, status: res?.status ?? 'fetch-failed' },
    });
    return res != null;
  };

  if (matchingBot.is_chatfuel) {
    const textsForTraining: string[] = [];
    let chatfuels: string[] = [];
    let set_attributes = '';
    let set_attributes_obj: Record<string, unknown> | undefined;
    for (const dfmessage of messages) {
      if (dfmessage.type === 4 && dfmessage.payload) {
        const keys = Object.keys(dfmessage.payload);
        textsForTraining.push(
          `Redirects to Chatfuel block(s): \`\`\`${JSON.stringify(dfmessage.payload.redirect_to_blocks, null, 2)}\`\`\``,
        );
        for (const k of keys) {
          if (k === 'redirect_to_blocks') {
            chatfuels = dfmessage.payload.redirect_to_blocks as string[];
          }
          if (k === 'set_attributes') {
            set_attributes_obj = dfmessage.payload.set_attributes as Record<string, unknown>;
            for (const key of Object.keys(set_attributes_obj)) {
              let val = set_attributes_obj[key];
              if (val === 'null' || val === 'not set') val = '';
              set_attributes += `&${key}=${val}`;
            }
          }
        }
      }
    }
    if (chatfuels.length > 0 || set_attributes !== '') {
      if (channel.isWordhopChannel === true) {
        if (matchingBot.chatfuel_token && matchingBot.chatfuel_botid) {
          const tasks: string[] = [];
          if (chatfuels.length > 0) {
            for (const block of chatfuels) {
              tasks.push(
                `https://api.chatfuel.com/bots/${matchingBot.chatfuel_botid}/users/${userid}/send?chatfuel_token=${matchingBot.chatfuel_token}&chatfuel_block_name=${block}${set_attributes}`,
              );
              set_attributes = ''; // verbatim: only the first block carries attrs
            }
          } else if (set_attributes !== '') {
            tasks.push(
              `https://api.chatfuel.com/bots/${matchingBot.chatfuel_botid}/users/${userid}/send?chatfuel_token=${matchingBot.chatfuel_token}&chatfuel_block_name=Janis&user input=${set_attributes}`,
            );
          }
          for (const url of tasks) {
            await platformPost('chatfuel', encodeURI(url));
          }
          // Merge set_attributes into the customer user doc's data blob —
          // legacy controller.storage.users[userid].data → the contact's
          // metadata (platform-asserted traits live top-level) when the
          // conversation is contact-linked, else userProfile.attributes.
          if (set_attributes_obj) {
            const conv = await conversationForSource(ctx, channel.sourceChannel);
            if (conv?.contactId) {
              const { contacts } = await import('../../db/schema.js');
              const [contact] = await ctx.db
                .select()
                .from(contacts)
                .where(eq(contacts.id, conv.contactId))
                .limit(1);
              if (contact) {
                await ctx.db
                  .update(contacts)
                  .set({
                    metadata: {
                      ...((contact.metadata ?? {}) as Record<string, unknown>),
                      ...set_attributes_obj,
                    },
                  })
                  .where(eq(contacts.id, contact.id));
              }
            } else if (conv) {
              const prev = ((conv.userProfile ?? {}) as Record<string, any>).attributes ?? {};
              await ctx.db
                .update(conversations)
                .set({
                  userProfile: {
                    ...((conv.userProfile ?? {}) as Record<string, unknown>),
                    attributes: { ...prev, ...set_attributes_obj },
                  },
                })
                .where(eq(conversations.id, conv.id));
            }
          }
        } else {
          await pushFail();
        }
      }
      // non-wordhop channel: textsForTraining returns to the caller — no post
    }
    return;
  }

  if (matchingBot.is_manychat) {
    let flow: string | undefined;
    for (const dfmessage of messages) {
      if (dfmessage.type === 4 && dfmessage.payload) {
        const keys = Object.keys(dfmessage.payload);
        if (keys.length === 1 && keys[0] === 'flow') {
          flow = dfmessage.payload.flow as string;
          break;
        }
      }
    }
    if (flow) {
      if (channel.isWordhopChannel === true) {
        if (matchingBot.manychat_token) {
          const body = JSON.stringify({ subscriber_id: userid, flow_ns: flow });
          await platformPost('manychat', 'https://api.manychat.com/fb/sending/sendFlow', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${matchingBot.manychat_token}`,
              'Content-Type': 'application/json',
            },
            body,
          });
        } else {
          await pushFail();
        }
      }
    }
    return;
  }
}

// sendToUser — the send_to_user/suggested_response mainline (slack_bot.js
// 3864-4071). Resolves the intent on the CUSTOMER's DF agent, resubmits the
// customer turn with the intent's dfEvent + contexts, and pushes the
// fulfillment to the customer — the "send this answer to the user" button.
export async function sendToUser(
  ctx: Ctx,
  message: SlackInbound,
  action: { name?: string; value?: string } | undefined,
  override?: { txt?: string | null; intentId?: string },
): Promise<void> {
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  if (!channel?.sourceChannel) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'send_to_user: no source channel' });
    return;
  }
  const original = (message as any).original_message ?? {};

  // getIntentIdFromMessage (training.js 1822): reply_type attachment's
  // select name carries the intent id; 'new' means no stored intent.
  // The send_intent dialog passes submission.intent_id verbatim instead.
  let intentId = override?.intentId ?? 'new';
  if (override?.intentId == null) {
    for (let i = (original.attachments?.length ?? 0) - 1; i >= 0; i--) {
      const att = original.attachments[i];
      if (att.callback_id === 'reply_type' && att.actions?.[0]?.name) {
        intentId = att.actions[0].name;
        break;
      }
    }
  }

  // conversations.replies → the thread's first customer message is the txt.
  // The dialog path passes txt=null verbatim (override.txt === null).
  let txt: string | null = override?.txt ?? null;
  if (override?.txt === undefined && original.thread_ts) {
    const res = await ctx.api<any>(ctx.install.botToken, 'conversations.replies', {
      channel: message.channel,
      ts: original.thread_ts,
    });
    const msgs = res?.messages ?? [];
    if (msgs.length > 0) {
      txt = msgs[0].text ?? null;
      for (const att of msgs[1]?.attachments ?? []) {
        if (att.callback_id === 'intent_user_says' && att.fallback) {
          txt = att.fallback;
          break;
        }
      }
    }
  }

  // Customer agent DF credentials via the channel's client_key.
  const df = channel.clientKey ? await resolveAgentDf(ctx, channel.clientKey) : null;
  if (!df) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'send_to_user: no DF credentials' });
    return;
  }

  // findIntent → dfEvent + userSays fallback + input contexts.
  const { getIntentV1, detectIntentV1 } = await import('../dialogflow.js');
  const storedIntent =
    intentId !== 'new' ? await getIntentV1(df.project, intentId, df.sa) : null;
  if (txt == null && storedIntent?.userSays) {
    for (const us of storedIntent.userSays) {
      const joined = us.data.map((d) => d.text).join('');
      if (joined !== '') {
        txt = joined;
        break;
      }
    }
  }
  let event: string | null = storedIntent?.events?.[0]?.name ?? null;
  if (event == null && txt == null) event = 'unknown';
  const contexts = (storedIntent?.contexts ?? []).map((name) => ({ name, lifespan: 1 }));

  // Resubmit the turn on the customer's agent (wordhopapi sendToUser →
  // /sendtouser equivalent), then push the fulfillment to the customer.
  const res = await detectIntentV1(
    df.project,
    channel.sourceChannel,
    {
      text: txt ?? undefined,
      event: event ? { name: event, data: {} } : undefined,
      contexts,
      lang: df.lang ?? channel.lang ?? 'en',
    } as any,
    df.sa,
  ).catch((e: Error) => {
    ctx.result.errors.push(`send_to_user DF: ${String(e)}`);
    return null;
  });
  if (!res?.result) return;

  const speech = res.result.fulfillment?.speech ?? '';
  const msgTexts = (res.result.fulfillment?.messages ?? [])
    .map((m: any) => (typeof m.speech === 'string' ? m.speech : ''))
    .filter(Boolean);
  const text = [speech, ...msgTexts].filter(Boolean).join('\n').trim();
  if (!text) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'send_to_user: empty fulfillment' });
    return;
  }
  const conv = await conversationForSource(ctx, channel.sourceChannel);
  if (!conv) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'send_to_user: no source conversation' });
    return;
  }
  const { deliverToChannel } = await import('../channels.js');
  const delivery = await deliverToChannel(ctx.db, conv.id, text).catch(
    (e: Error) => ({ delivered: false as const, error: String(e) }),
  );
  if ((delivery as { delivered?: boolean }).delivered === false) {
    ctx.result.errors.push(`send_to_user delivery: ${(delivery as { error?: string }).error ?? 'failed'}`);
    return;
  }
  ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'send_to_user' });
}

// ── channelResponse — the customer relay (pause-on-send + deliver) ──────────
// Verbatim gate order: non-SLACKBOT → removeFormatting → Pro gate → source
// channel → direct_mention reject → sendChatResponse (pause + send) →
// error → botSay error (+reconnect button on auth failure).

export async function channelResponse(
  ctx: Ctx,
  message: SlackInbound,
  channel: NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>>,
): Promise<{ ok: boolean; error?: string }> {
  if (!channel.isWordhopChannel) {
    return { ok: false, error: 'not a transcript channel' };
  }
  if (message.user === 'USLACKBOT') return { ok: false, error: 'SLACKBOT' };
  message.text = removeFormatting(message.text ?? '') as string;
  if (!ctx.pro) {
    return { ok: false, error: 'not on pro plan' };
  }
  if (/(^|\s)@[a-z0-9._-]+/i.test(message.text ?? '') && message.type == null) {
    // direct_mention guard (legacy rejects mentions in the relay path)
    return { ok: false, error: 'direct_mention' };
  }
  if ((message.text ?? '') === '' && !(message.attachments?.length || message.files?.length)) {
    return { ok: true };
  }

  const conv = await conversationForSource(ctx, channel.sourceChannel);
  if (!conv) return { ok: false, error: 'no source conversation' };

  // send_chat_response findChannels leg: operator send pauses the source
  // channel (paused=true, pauseDuration=10, warningSent=false) and fires a
  // channel update — the takeover mechanic.
  const userRow = await slackUserToRow(ctx, message.user);
  if (conv.state !== 'human') {
    await takeover(ctx.db, ctx.install.workspaceId, conv.id, userRow);
  }
  await ctx.db
    .update(conversations)
    .set({ humanSince: new Date(), resumeWarnedAt: null, pauseMinutes: 10 })
    .where(eq(conversations.id, conv.id));

  const send = await humanReply(
    ctx.db,
    ctx.install.workspaceId,
    conv.id,
    userRow,
    message.text ?? '',
    (message.files ?? []).map((f) => ({
      name: f.name ?? 'file',
      url: f.url_private ?? '',
      type: f.mimetype ?? 'application/octet-stream',
      size: 0,
    })),
    true, // viaSlack
    message.ts,
  ).catch(async (e: Error) => {
    // Verbatim error surface: botSay the failure; auth errors get the
    // reconnect-to-Facebook button attachment.
    const reconnect = reconnectMessengerButtons(
      `${JANIS_WEBAPP()}/fb/?client_key=${channel.clientKey ?? ''}`,
    );
    await ctx.say({ channel: message.channel, text: String(e.message ?? e), attachments: reconnect });
    return { error: String(e) };
  });
  if ('error' in send) return { ok: false, error: send.error };
  ctx.result.posted.push({ channel: message.channel, ts: send.message.id, kind: 'relay:customer' });
  return { ok: true };
}

// sendMessageAsBot — the /bot command path (verbatim guards + ack semantics).
export async function sendMessageAsBot(
  ctx: Ctx,
  message: SlackInbound,
): Promise<{ ok: boolean; error?: string }> {
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  if ((message.text ?? '') === '' && !message.attachments?.length && !message.files?.length) {
    return { ok: true };
  }
  if (message.text == null) message.text = ' ';
  if (!channel || !channel.sourceChannel) {
    await ctx.say({ channel: message.channel, text: slashCommandWarning });
    return { ok: false, error: 'no source channel' };
  }
  return channelResponse(ctx, message, channel);
}

// ── Slash commands (slack_bot.js 1867-2038) — alias normalize verbatim ─────

const SLASH_ALIASES: Record<string, string> = {
  '/pause_s': '/pause',
  '/resume_s': '/resume',
  '/broadcast_s': '/broadcast',
  '/pause_qa': '/pause',
  '/resume_qa': '/resume',
  '/bot_s': '/bot',
  '/blast': '/bot',
  '/say': '/bot',
  '/say_s': '/bot',
};

export async function handleClassicSlash(
  ctx: Ctx,
  command: string,
  text: string,
  channelId: string,
  userId: string,
): Promise<{ ephemeral?: string; ok?: boolean }> {
  const cmd = SLASH_ALIASES[command] ?? command;
  const channel = await getClassicChannelBySlackId(ctx.db, channelId);

  switch (cmd) {
    case '/pause': {
      if (!channel?.sourceChannel) return { ephemeral: slashCommandWarning };
      let minutes = 10;
      let customDuration = false;
      if (text.length > 0) {
        minutes = /^(unlimited|forever|infinity)$/i.test(text) ? -1 : parseInt(text, 10);
        customDuration = true;
      }
      const conv = await conversationForSource(ctx, channel.sourceChannel);
      if (!conv) return { ephemeral: slashCommandWarning };
      const userRow = await slackUserToRow(ctx, userId);
      if (conv.state !== 'human') {
        await takeover(ctx.db, ctx.install.workspaceId, conv.id, userRow);
      }
      await ctx.db
        .update(conversations)
        .set({ humanSince: new Date(), resumeWarnedAt: null, pauseMinutes: minutes })
        .where(eq(conversations.id, conv.id));
      // Legacy also latches transcribe=true on the source channel doc —
      // mirrored on the registry row (the source-channel doc equivalent).
      await saveClassicChannel(ctx.db, {
        installationId: ctx.install.id,
        sourceChannel: channel.sourceChannel,
        paused: true,
        shouldProcessTranscript: true,
        lastAgentTs: new Date(),
      });
      return { ok: true };
    }
    case '/resume': {
      if (!channel?.sourceChannel) return { ephemeral: slashCommandWarning };
      const conv = await conversationForSource(ctx, channel.sourceChannel);
      if (!conv) return { ephemeral: slashCommandWarning };
      const userRow = await slackUserToRow(ctx, userId);
      if (conv.state === 'human') {
        await resume(ctx.db, ctx.install.workspaceId, conv.id, userRow);
      }
      await saveClassicChannel(ctx.db, {
        installationId: ctx.install.id,
        sourceChannel: channel.sourceChannel,
        paused: false,
      });
      return { ok: true };
    }
    case '/bot': {
      const res = await sendMessageAsBot(ctx, {
        channel: channelId,
        user: userId,
        text,
        type: 'message',
        command: '/bot',
      });
      return res.ok ? { ok: true } : { ephemeral: slashCommandWarning };
    }
    case '/wordhop': {
      // DM shell — routes through incoming() verbatim.
      await classicIncoming(ctx, { channel: channelId, user: userId, text: text || 'help', command: '/wordhop' });
      return { ok: true };
    }
    default:
      return { ephemeral: `I'm afraid I don't know how to ${command} yet.` };
  }
}

// ── processIncoming (non-j-channel, slack_bot.js 9867-10135) ───────────────
// Verbatim order: filter-severity replies (callback_id OR latched
// filtertype) → >255 → paused → broadcasting fan-out → else apirequest:
// the WORDHOP_CLIENT_KEY meta-bot DF query → apiaiResponse dispatch.

const matchTag = (m: string): string => {
  // verbatim (10237-10249): <x> → '<a href="…">…</a>'; non-'h' prefix wraps
  // the tag in extra <> — the legacy double-bracket quirk.
  const inner = m.slice(1, -1);
  const p = inner.split('|');
  const anchor = `<a href="${p[0]}">${p.length === 1 ? p[0] : p[1]}</a>`;
  return inner.startsWith('h') ? anchor : `<${anchor}>`;
};

async function processIncomingClassic(
  ctx: Ctx,
  message: SlackInbound,
  channel: NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>> | null,
): Promise<void> {
  const {
    DM_SENTINEL, getClassicPrefs, getMemberShellState, setMemberFilterSeverity,
    setMemberShellState,
  } = await import('./store.js');
  const userId = message.user ?? '';
  const shell = userId ? await getMemberShellState(ctx.db, ctx.install.id, userId) : null;
  const doc: any = userId ? await getClassicPrefs(ctx.db, ctx.install.id, userId, DM_SENTINEL) : {};

  let input = message.text ?? '';
  let event = message.event;
  if (event) {
    if (input === '') {
      input = event;
      message.text = event;
    }
  }
  if ((message as any).callback_event) {
    event = (message as any).callback_event;
    delete (message as any).callback_event;
  }
  if (input === '') return;

  // Filter-severity replies — verbatim order, before every other check.
  if (shell?.filtertype || (message.callback_id ?? '').startsWith('filter_')) {
    const wrote = await setMemberFilterSeverity(ctx.db, ctx.install.id, userId, shell ?? {}, input);
    if (wrote) {
      ctx.result.posted.push({ channel: message.channel, ts: '', kind: `filter:${shell?.filtertype ?? message.callback_id}` });
      return;
    }
  }

  if (input.length > 255 && shell?.broadcasting !== true && doc.paused !== true) {
    await ctx.say({
      channel: message.channel,
      text: " OK got it! I've passed that message on to the Janis team.",
    });
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'unknown-intent' });
    return;
  }
  if (doc.paused === true && message.sendToUser !== true) {
    // hopIn only — paused docs log but take no action.
    return;
  }

  if (shell?.broadcasting) {
    // Broadcast fan-out (slack_bot.js 9963-10030): the input — JSON payloads
    // verbatim, strings as text — is sendChatResponse'd to every subscribed
    // source channel of the context bot. New-stack equivalent: every
    // conversation of the agent carrying this client_key.
    await setMemberShellState(ctx.db, ctx.install.id, userId, { broadcasting: false });
    const clientKey = shell.botContext?.client_key;
    if (clientKey) {
      let payload: unknown = removeFormatting(input);
      try {
        payload = JSON.parse(String(payload));
      } catch {
        /* plain text */
      }
      const { agents } = await import('../../db/schema.js');
      const [agent] = await ctx.db
        .select()
        .from(agents)
        .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
        .limit(1);
      if (agent) {
        const convs = await ctx.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.agentId, agent.id), sql`${conversations.state} <> 'archived'`));
        const { deliverToChannel } = await import('../channels.js');
        for (const c of convs) {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          const res = await deliverToChannel(ctx.db, c.id, text).catch(
            (e: Error) => ({ delivered: false as const, error: String(e) }),
          );
          if ((res as { delivered?: boolean }).delivered !== false) {
            ctx.result.posted.push({ channel: c.id, ts: '', kind: 'broadcast:customer' });
          }
        }
      }
    }
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'broadcast:end' });
    return;
  }

  // apirequest — the WORDHOP meta-bot shell (slack_bot.js 10047-10135):
  // session entities (bot names / apiai_keys) + myContexts → DF →
  // apiaiResponse. sessionId is the MEMBER, not the channel.
  const { botObjsForWorkspace } = await import('./adminActions.js');
  const botObjs = await botObjsForWorkspace(ctx);
  const mb = await resolveTranscriptBot(ctx, 'wordhop');
  if (!mb) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'dm shell: no meta-bot creds' });
    return;
  }
  const apikeyEnts = botObjs.filter((b) => (b as any).apiai_key).map((b) => ({
    value: (b as any).apiai_key as string,
    synonyms: [(b as any).apiai_key as string],
  }));
  const entities = [
    { name: 'bot', extend: 1, entries: botObjs.map((b) => ({ value: b.name, synonyms: [b.name] })) },
    { name: 'apiai_key', extend: 1, entries: apikeyEnts },
  ];
  let text = input;
  text = text.replace(/<(.*?)>/g, matchTag);
  const query: Record<string, unknown> = {
    text,
    contexts: doc.incoming_contexts ?? [],
    entities,
    lang: (doc.lang as string) ?? 'en',
  };
  if (event) {
    query.event =
      typeof event === 'string'
        ? { name: event, data: { userSays: text } }
        : { ...(event as Record<string, unknown>) };
    delete query.text;
  }
  const { detectIntentV1 } = await import('../dialogflow.js');
  const res = await detectIntentV1(mb.sa.project_id, userId || message.channel, query as any, mb.sa).catch(
    (e: Error) => {
      ctx.result.errors.push(`meta-bot detect: ${String(e)}`);
      return null;
    },
  );
  if (!res?.result) return;
  const shellChannel = channel ?? ({
    slackChannelId: message.channel,
    sourceChannel: '',
    clientKey: null,
    isWordhopChannel: false,
    isTrainingChannel: false,
  } as NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>>);
  await classicApiAiResponse(ctx, message, res, shellChannel);
}

// ── files_uploaded (slack_bot.js 2113-2190) ────────────────────────────────
// Slack file → sharedPublicURL → j-channel: relay to customer as an image
// attachment via sendMessageAsBot; other channels: incoming() with the URL
// as text.

export async function handleClassicFilesUploaded(
  ctx: Ctx,
  message: SlackInbound,
): Promise<void> {
  const botUserId =
    (ctx.install.classicConfig as { botUserId?: string })?.botUserId ?? '';
  if (botUserId && message.user === botUserId) return;
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  if (!channel) return;
  const file = message.files?.[0];
  if (!file?.url_private) return;

  const uToken =
    ctx.install.installerUserToken ??
    (ctx.install.classicConfig as { userToken?: string }).userToken ??
    ctx.install.botToken;
  const res = await ctx.api<{ file?: { permalink_public?: string } }>(
    uToken,
    'files.sharedPublicURL',
    { file: (file as { id?: string }).id },
  );
  const permalink = res.file?.permalink_public ?? file.url_private;
  const pubSecret = permalink.split('-').pop() ?? '';

  if (channel.isWordhopChannel || channel.isTrainingChannel) {
    const msg: SlackInbound = {
      channel: message.channel,
      user: message.user,
      ts: message.ts,
      text: ' ',
      attachments: [
        { type: 'image', payload: { url: `${file.url_private}?pub_secret=${pubSecret}` } },
      ],
    };
    if (channel.isWordhopChannel) {
      await sendMessageAsBot(ctx, msg);
    } else {
      await classicIncoming(ctx, msg);
    }
    return;
  }
  await classicIncoming(ctx, {
    ...message,
    text: `${file.url_private}?pub_secret=${pubSecret}`,
  });
}

// ── Interactive callbacks — DF-free dispatch ───────────────────────────────

export async function handleClassicCallback(
  ctx: Ctx,
  callbackId: string,
  message: SlackInbound,
): Promise<void> {
  const action = message.actions?.[0];

  // ── dialog submissions (slack_bot.js 1541-1810) ──────────────────────────
  if (message.submission) {
    await handleClassicDialogSubmission(ctx, callbackId, message);
    return;
  }

  // archive_channel is checked BEFORE the channel-doc lookup (2852-2859) —
  // verbatim archives via the installer user token and does NOT delete the
  // stored channel doc.
  if (callbackId === 'archive_channel') {
    await ctx.api(ctx.install.installerUserToken ?? ctx.install.botToken, 'conversations.archive', {
      channel: message.channel,
    });
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'callback:archive' });
    return;
  }

  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  if (channel == null) return;
  if (message.callback_id == null) message.callback_id = callbackId;
  const threadTs = message.original_message?.thread_ts;
  const actionValue = (action?.value ?? '').toLowerCase();
  // Botkit normalizes message.text to the clicked label for selects/buttons.
  if (message.text == null || message.text === '') {
    message.text = (action as any)?.selected_options?.[0]?.text ?? (action as any)?.text ?? action?.value ?? '';
  }

  // Pre-training shortcuts (2871-2892).
  if (callbackId === 'manychat.add.token' && actionValue === 'add token') {
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    const doc = message.user
      ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
      : {};
    const { addManyChatTokenDialog } = await import('./adminActions.js');
    await addManyChatTokenDialog(ctx, channel, doc as any, message.trigger_id ?? '');
    return;
  }
  if (callbackId === 'generic_callback' && actionValue === 'edit') {
    const { getClassicPrefs, DM_SENTINEL } = await import('./store.js');
    const doc = message.user
      ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
      : {};
    const { editBotModalDialog } = await import('./adminActions.js');
    await editBotModalDialog(ctx, channel, doc as any, message.trigger_id ?? '');
    return;
  }
  if (
    threadTs == null &&
    callbackId === 'set_bot' &&
    message.text !== 'Add a bot' &&
    message.text !== 'Help'
  ) {
    await buttonClicked(ctx, { ...message, callback_event: 'set_bot' }, channel);
    return;
  }

  // Threaded training dispatch (2927-2932): (thread_ts && wordhop) || training.
  if ((threadTs && channel.isWordhopChannel) || channel.isTrainingChannel) {
    const { handleTrainingCallback } = await import('./trainingCallbacks.js');
    const handled = await handleTrainingCallback(ctx, callbackId, message);
    if (!handled) {
      ctx.result.suppressed.push({
        channel: message.channel,
        reason: `callback unhandled: ${callbackId}`,
      });
    }
    return;
  }

  // Threaded alert-settings thread (2934-3225): set_bot / filter_alert /
  // intent_selection_alerts re-render via chat.update, then return —
  // log_buttons falls through.
  if (threadTs && callbackId !== 'log_buttons') {
    if (callbackId === 'set_bot') await threadedSetBot(ctx, message, action);
    else if (callbackId === 'filter_alert') await threadedFilterAlert(ctx, message, action);
    else if (callbackId === 'intent_selection_alerts')
      await threadedIntentSelectionAlerts(ctx, message, action);
    return;
  }

  // Wordhop-channel transcript-card buttons → transcriptFunctions (3216-3252).
  if (channel.isWordhopChannel === true) {
    if (callbackId === 'suggested_response' && action?.name === 'Send') {
      const original = message.original_message ?? {};
      const attachments = [...(original.attachments ?? [])];
      attachments.shift();
      const text = attachments[0]?.text ?? '';
      attachments.shift();
      for (const att of attachments) {
        if (att.text == null || att.text === '') att.text = '';
      }
      await channelResponse(
        ctx,
        {
          ...message,
          text,
          attachments,
          callback_id: callbackId,
          replyts: Number(action.value),
        },
        channel,
      );
      return;
    }
    await transcriptFunctions(ctx, message, channel);
    return;
  }

  // Non-wordhop tail (3253-3389).
  const FILTER_BUTTON_IDS = new Set([
    'filter_sentiment_mute',
    'filter_assistance_mute',
    'filter_custom_alert',
    'filter_failure_mute',
    'filter_assistance',
    'filter_sentiment',
    'filter_failure',
    'filter_buttons',
  ]);
  if (FILTER_BUTTON_IDS.has(callbackId)) {
    await buttonClicked(ctx, message, channel);
    return;
  }
  if (callbackId === 'toggle_agent') {
    const pickedOpt = action?.selected_options?.[0];
    const picked = message.text ?? pickedOpt?.value ?? '';
    if (picked === 'new' || picked === 'Create New Agent') {
      await classicIncoming(ctx, { ...message, text: 'Create New Agent' });
      return;
    }
    // Resolve the picked option's label from the original select's options.
    let text = picked;
    const value = (pickedOpt?.value ?? '').replace(/projects\//g, '');
    const originalOptions = message.original_message?.attachments?.[0]?.actions?.[0]?.options;
    if (Array.isArray(originalOptions)) {
      const opt = originalOptions.find((o: any) => o.value === pickedOpt?.value);
      if (opt) text = opt.text;
    }
    await youSaid(ctx, message, text);
    ctx.result.suppressed.push({
      channel: message.channel,
      reason: 'toggle_agent: addBotFromAgent needs user Google OAuth link',
    });
    return;
  }
  if (callbackId === 'resume_buttons_with_source_channel') {
    if (channel.sourceChannel) {
      const conv = await conversationForSource(ctx, channel.sourceChannel);
      if (conv) {
        const userRow = await slackUserToRow(ctx, message.user);
        if (conv.state === 'human')
          await resume(ctx.db, ctx.install.workspaceId, conv.id, userRow);
      }
    }
    const attachments = addToAttachments(message);
    attachments.pop();
    await botReplyInteractive(ctx, message, { text: '', attachments });
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'callback:resume' });
    return;
  }
  if (callbackId === 'log_buttons') {
    if (action?.name === 'Take Over') {
      const attachments = addToAttachments(message);
      const last = { ...(attachments[attachments.length - 1] ?? {}) };
      if (Array.isArray(last.actions)) {
        last.actions = [...last.actions];
        last.actions.shift();
      }
      attachments[attachments.length - 1] = last;
      await botReplyInteractive(ctx, message, {
        text: message.original_message?.text ?? '',
        attachments,
      });
    } else {
      await buttonClicked(ctx, message, channel);
    }
    return;
  }
  if (callbackId === 'generic_callback') {
    await buttonClicked(ctx, message, channel);
    return;
  }
  // Catch-all (3377-3389): every remaining callback_id → buttonClicked →
  // botReplyAsUser → youSaid + incoming. Legacy's add_apiai_key/integrate_help
  // exclusion and the bot.name.save/summary_page/prior_messages_buttons
  // removeButtonsClicked branch are dead code — the trailing else catches all.
  await buttonClicked(ctx, message, channel);
}

// addToAttachments (6227-6246) — copy original_message.attachments verbatim:
// strip attachment/action ids, normalize empty text.
function addToAttachments(message: SlackInbound): any[] {
  const original = message.original_message;
  if (original == null) return [];
  const attachments = (original.attachments ?? []).map((a: any) => {
    const att = { ...a };
    delete att.id;
    if (Array.isArray(att.actions)) {
      att.actions = att.actions.map((act: any) => {
        const c = { ...act };
        delete c.id;
        return c;
      });
    }
    if (att.text === '' || !att.text) att.text = '';
    return att;
  });
  return attachments;
}

// ── threaded alert-settings callbacks (slack_bot.js 2934-3225) ────────────

async function threadedSetBot(ctx: Ctx, message: SlackInbound, action: any): Promise<void> {
  const { getClassicPrefs, setMemberDocSettings, DM_SENTINEL } = await import('./store.js');
  const doc: any = message.user
    ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
    : {};
  const { botObjsForWorkspace, botSettingsMessage, saveBotContext } = await import('./adminActions.js');
  const botObjs = await botObjsForWorkspace(ctx);
  if (message.text !== 'All bots') {
    doc.bot_name = message.text;
    saveBotContext(botObjs, doc);
    await setMemberDocSettings(ctx.db, ctx.install.id, message.user ?? '', doc);
  }
  const matchingBot =
    message.text === 'All bots'
      ? { name: 'All bots' }
      : botObjs.find((o) => o.client_key === (doc.bot_context as any)?.client_key) ??
        botObjs.find((o) => o.name === doc.bot_name);
  if (!matchingBot) return;
  const m = botSettingsMessage(botObjs, matchingBot as any, 0, 0, doc);
  await ctx.api(ctx.install.botToken, 'chat.update', {
    ts: message.original_message?.ts,
    channel: message.channel,
    text: m.text,
    attachments: m.attachments,
  });
  ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'callback:set_bot' });
}

async function threadedFilterAlert(
  ctx: Ctx,
  message: SlackInbound,
  action: any,
): Promise<void> {
  const { getClassicPrefs, setMemberDocSettings, DM_SENTINEL } = await import('./store.js');
  const doc: any = message.user
    ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
    : {};
  const { botObjsForWorkspace, botSettingsMessage, getBotAlertSettings } = await import('./adminActions.js');
  const botObjs = await botObjsForWorkspace(ctx);
  let type = 0;
  const page = 0;
  if (action?.value === 'manage_custom_alerts') {
    type = 3;
  } else {
    const enabled = Math.abs(Number(action?.selected_options?.[0]?.value ?? 0));
    if (action?.name === 'filter_custom') type = 3;
    const FIELD: Record<string, string> = {
      filter_failure: 'logSeverityLevel',
      filter_sentiment: 'userUpsetSeverityLevel',
      filter_human: 'helpNeededSeverityLevel',
      filter_error: 'errorWarningLevel',
      filter_custom: 'customAlertSeverityLevel',
    };
    const field = FIELD[action?.name ?? ''];
    const origSelected =
      message.original_message?.attachments?.[0]?.actions?.[0]?.selected_options?.[0]?.value;
    if (field) {
      if (origSelected === 'All bots') {
        for (const botObj of botObjs) {
          getBotAlertSettings(doc, botObj.client_key)[field] = enabled;
        }
        doc[field] = enabled;
      } else {
        getBotAlertSettings(doc, doc.bot_context?.client_key)[field] = enabled;
      }
      await setMemberDocSettings(ctx.db, ctx.install.id, message.user ?? '', doc);
    }
  }
  const matchingBot: any =
    message.original_message?.attachments?.[0]?.actions?.[0]?.selected_options?.[0]?.value ===
    'All bots'
      ? { name: 'All bots', value: 'All bots' }
      : botObjs.find((o) => o.client_key === (doc.bot_context as any)?.client_key) ??
        botObjs.find((o) => o.name === doc.bot_name);
  if (!matchingBot) return;
  const m = botSettingsMessage(botObjs, matchingBot, page, type, doc);
  await ctx.api(ctx.install.botToken, 'chat.update', {
    ts: message.original_message?.ts,
    channel: message.channel,
    text: m.text,
    attachments: m.attachments,
  });
  ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'callback:filter_alert' });
}

async function threadedIntentSelectionAlerts(
  ctx: Ctx,
  message: SlackInbound,
  action: any,
): Promise<void> {
  const { getClassicPrefs, setMemberDocSettings, DM_SENTINEL } = await import('./store.js');
  const doc: any = message.user
    ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
    : {};
  const { botObjsForWorkspace, botSettingsMessage, getBotAlertSettings } = await import('./adminActions.js');
  const botObjs = await botObjsForWorkspace(ctx);
  const addingIntent = action?.name === 'manage_intent_alert';
  const deletingIntent = action?.name === 'delete';
  let page = 0;
  if (action?.selected_options && action.name === 'alert_intent_page_label') {
    page = Number(action.selected_options[0]?.value ?? 0);
  }
  const matchingBot: any =
    botObjs.find((o) => o.client_key === (doc.bot_context as any)?.client_key) ??
    botObjs.find((o) => o.name === doc.bot_name);
  if (!matchingBot) return;
  const botAlertSettings = getBotAlertSettings(doc, matchingBot.client_key);
  if (botAlertSettings.intents == null) botAlertSettings.intents = [];
  if (addingIntent) {
    const intentId = action?.selected_options?.[0]?.value;
    const df = matchingBot.client_key ? await resolveAgentDf(ctx, matchingBot.client_key) : null;
    if (df && intentId) {
      const { getIntentV1 } = await import('../dialogflow.js');
      const intent = await getIntentV1(df.project, intentId, df.sa).catch(() => null);
      if (intent) {
        const intents = (botAlertSettings.intents as any[]).filter((o) => o.id !== intent.id);
        intents.unshift({ name: intent.name, id: intent.id });
        botAlertSettings.intents = intents;
      }
    } else {
      ctx.result.suppressed.push({
        channel: message.channel,
        reason: 'intent_selection_alerts add: no DF creds',
      });
    }
  } else if (deletingIntent) {
    botAlertSettings.intents = (botAlertSettings.intents as any[]).filter(
      (o) => o.id !== action?.value,
    );
  }
  await setMemberDocSettings(ctx.db, ctx.install.id, message.user ?? '', doc);
  const m = botSettingsMessage(botObjs, matchingBot, page, 3, doc);
  await ctx.api(ctx.install.botToken, 'chat.update', {
    ts: message.original_message?.ts,
    channel: message.channel,
    text: m.text,
    attachments: m.attachments,
  });
  ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'callback:intent_selection_alerts' });
}

// transcriptFunctions (slack_bot.js 10254-10633) — wordhop-channel card
// buttons: Leave/Transcribe/Help/Pause/Resume/About User handled locally,
// everything else → incoming() (the meta-bot turn via transcriptChannelShell).
async function transcriptFunctions(
  ctx: Ctx,
  message: SlackInbound,
  channel: NonNullable<Awaited<ReturnType<typeof getClassicChannelBySlackId>>>,
): Promise<void> {
  const action = message.actions?.[0];
  message.paused = channel.paused;

  if (action?.name === 'Leave Channel' || action?.name === 'Leave') {
    const res = await ctx
      .api(ctx.install.installerUserToken ?? ctx.install.botToken, 'conversations.kick', {
        user: message.user,
        channel: channel.slackChannelId,
      })
      .catch((e) => ({ error: String(e) }) as any);
    if (res?.error === 'cant_kick_self') {
      await ctx.api(ctx.install.installerUserToken ?? ctx.install.botToken, 'conversations.leave', {
        channel: channel.slackChannelId,
      });
    }
    return;
  }
  if (action?.name === 'Transcribe') {
    const attachments = addToAttachments(message);
    attachments.pop();
    attachments.push({ text: '_ You clicked *' + (message.text ?? '') + '*_' });
    await botReplyInteractive(ctx, message, {
      text: message.original_message?.text ?? '',
      attachments,
    });
    await saveClassicChannel(ctx.db, {
      installationId: ctx.install.id,
      slackChannelId: channel.slackChannelId,
      sourceChannel: channel.sourceChannel,
      shouldProcessTranscript: true,
    });
    const { pauseResumeButtons } = await import('./buttons.js');
    const res = await ctx.say({
      channel: message.channel,
      text: ":robot_face: I've resumed transcribing the conversation in this channel.",
      attachments: [pauseResumeButtons({ paused: channel.paused })],
    });
    ctx.result.posted.push({
      channel: message.channel,
      ts: res.ts ?? '',
      kind: 'transcript:transcribe',
    });
    return;
  }
  if (action?.name === 'Help') {
    const attachments = addToAttachments(message);
    attachments.pop();
    attachments.push({ text: '_ You clicked *' + (message.text ?? '') + '*_' });
    await botReplyInteractive(ctx, message, {
      text: message.original_message?.text ?? '',
      attachments,
    });
    await transcriptChannelShell(
      ctx,
      { text: 'help', channel: message.channel, user: message.user },
      channel,
    );
    return;
  }
  if (action?.name === 'Pause') {
    if (message.trigger_id) {
      const dialog = {
        callback_id: 'pause_modal',
        title: 'Pause',
        submit_label: 'Pause',
        notify_on_cancel: false,
        elements: [
          {
            label: 'Select a duration',
            type: 'select',
            name: 'duration',
            value: '10',
            placeholder: 'Select pause duration',
            optional: true,
            options: [
              { label: '5 minutes', value: 5 },
              { label: '10 minutes', value: 10 },
              { label: '30 minutes', value: 30 },
              { label: '60 minutes', value: 60 },
              { label: '24 hours', value: 1440 },
              { label: 'Forever', value: -1 },
            ],
          },
          {
            label: 'Or set a custom duration',
            name: 'custom_duration',
            type: 'text',
            value: '',
            placeholder: 'How many minutes?',
            optional: true,
          },
        ],
      };
      await openClassicDialog(ctx, {
        triggerId: message.trigger_id,
        dialog,
        channel: message.channel,
        user: message.user,
      });
      ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'dialog:pause_modal' });
    }
    return;
  }
  if (action?.name === 'Resume') {
    if (channel.sourceChannel) {
      const conv = await conversationForSource(ctx, channel.sourceChannel);
      if (conv) {
        const userRow = await slackUserToRow(ctx, message.user);
        if (conv.state === 'human')
          await resume(ctx.db, ctx.install.workspaceId, conv.id, userRow);
        await saveClassicChannel(ctx.db, {
          installationId: ctx.install.id,
          slackChannelId: channel.slackChannelId,
          sourceChannel: channel.sourceChannel,
          paused: false,
        });
      }
    }
    const attachments = addToAttachments(message);
    attachments.pop();
    attachments.push({ text: '_ You clicked *' + (message.text ?? '') + '*_' });
    await botReplyInteractive(ctx, message, {
      text: message.original_message?.text ?? '',
      attachments,
    });
    return;
  }
  if (action?.name === 'About User') {
    // Profile card → thread on the "See the `1 reply` below" reply.
    const conv = channel.sourceChannel
      ? await conversationForSource(ctx, channel.sourceChannel)
      : null;
    const profile = { ...((conv?.userProfile ?? {}) as Record<string, unknown>) };
    let contactMeta: Record<string, unknown> = {};
    if (conv?.contactId) {
      const { contacts } = await import('../../db/schema.js');
      const [contact] = await ctx.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, conv.contactId))
        .limit(1);
      contactMeta = (contact?.metadata ?? {}) as Record<string, unknown>;
      if (contact?.name && profile.name == null) profile.name = contact.name;
      if (contact?.avatarUrl && profile.image == null) profile.image = contact.avatarUrl;
      if (contact?.email && profile.email == null) profile.email = contact.email;
    }
    const data: Record<string, unknown> = { ...profile, ...contactMeta };
    const fields: any[] = [{ short: false, value: '*Name*: ' + (profile.name ?? '') }];
    const tags: any[] = [];
    const customFields: any[] = [];
    const attributes: any[] = [];
    let profilePic: any;
    const profileFields = ['timezone', 'gender', 'locale', 'language', 'status', 'page_id', 'id'];
    const hiddenFields = [
      'live_chat_url',
      'name',
      'first_name',
      'last_name',
      'last_input_text',
      'last name',
      'first name',
      'page_id',
    ];
    for (const key of Object.keys(data)) {
      const item = data[key];
      if (key === 'image') {
        profilePic = { text: '', image_url: item };
      } else if (key === 'tags' && Array.isArray(item)) {
        for (const tag of item) tags.push({ short: false, value: tag?.name ?? tag });
      } else if (key === 'custom_fields' && Array.isArray(item)) {
        for (const cf of item) {
          if (cf?.value)
            customFields.push({ short: false, value: '*' + cf.name + '*: ' + cf.value });
        }
      } else if (!hiddenFields.includes(key) && profileFields.includes(key) && item && item !== 'undefined') {
        const label = key.replace('_', ' ');
        fields.push({
          short: false,
          value: '*' + label.charAt(0).toUpperCase() + label.slice(1) + '*: ' + String(item),
        });
      } else if (!hiddenFields.includes(key) && item && item !== 'null' && item !== 'undefined') {
        const label = key.replace('_', ' ');
        let itemtxt: string;
        try {
          itemtxt = JSON.stringify(item, null, 2);
        } catch {
          itemtxt = String(item);
        }
        attributes.push({ short: false, value: '*' + label + '*: ' + itemtxt });
      }
    }
    const attachments: any[] = [];
    if (profile.image) {
      attachments.push({ text: '', image_url: profile.image });
    } else if (profilePic) {
      attachments.push(profilePic);
    }
    if (fields.length) attachments.push({ mrkdwn_in: ['fields'], fields });
    if (tags.length)
      attachments.push({ title: 'USER TAGS:', mrkdwn_in: ['fields'], color: '#7CD197', fields: tags });
    if (customFields.length)
      attachments.push({
        title: 'CUSTOM FIELDS:',
        mrkdwn_in: ['fields'],
        color: '#FFA500',
        fields: customFields,
      });
    if (attributes.length)
      attachments.push({
        title: 'ATTRIBUTES:',
        mrkdwn_in: ['fields'],
        color: '#7CD197',
        fields: attributes,
      });
    const res = await ctx.say({
      channel: message.channel,
      text: "See the `1 reply` below to view the user's profile:",
      thread_ts: message.ts ?? message.original_message?.ts,
    });
    ctx.result.posted.push({ channel: message.channel, ts: res.ts ?? '', kind: 'profile:prompt' });
    const thread = await ctx.say({
      channel: message.channel,
      text: ' ',
      attachments,
      thread_ts: res.ts ?? message.ts,
    });
    ctx.result.posted.push({ channel: message.channel, ts: thread.ts ?? '', kind: 'profile:card' });
    return;
  }
  // else → incoming(bot, message): the meta-bot turn.
  await transcriptChannelShell(ctx, message, channel);
}

// ── Slack workspace-event sync (slack_bot.js 1275-1458, 1844-1855) ─────────
// channel_deleted → drop the doc; member_joined_channel → invite cards;
// channel_unarchive → invite+leave ping; everything else → updateChannel
// (conversations.info + conversations.members → save the channel doc).
export interface ClassicWorkspaceEvent {
  type: string;
  channel?: string;
  user?: string;
  inviter?: string;
  ts?: string;
  callback_id?: string;
}

export async function handleClassicWorkspaceEvent(
  ctx: Ctx,
  ev: ClassicWorkspaceEvent,
): Promise<void> {
  const cfg = ctx.install.classicConfig as { botUserId?: string };
  switch (ev.type) {
    case 'channel_deleted': {
      await ctx.db
        .delete(slackClassicChannels)
        .where(
          and(
            eq(slackClassicChannels.installationId, ctx.install.id),
            eq(slackClassicChannels.slackChannelId, ev.channel ?? ''),
          ),
        );
      ctx.result.posted.push({
        channel: ev.channel ?? '',
        ts: '',
        kind: 'sync:channel_deleted',
      });
      return;
    }
    case 'member_joined_channel': {
      if (ev.user && ev.user === cfg.botUserId) {
        const ures = await ctx
          .api<{ user?: { name?: string } }>(ctx.install.botToken, 'users.info', {
            user: ev.inviter,
          })
          .catch(() => ({} as { user?: { name?: string } }));
        const name = ures.user?.name ?? '';
        const stored = await getClassicChannelBySlackId(ctx.db, ev.channel ?? '');
        if (stored?.isWordhopChannel === true) {
          const { invitedToTranscriptMessage } = await import('./strings.js');
          const { pauseResumeButtons } = await import('./buttons.js');
          const msg = invitedToTranscriptMessage(
            `<@${ev.inviter}|${name}>`,
            stored.sourceChannel ?? '',
          );
          msg.attachments.push(
            pauseResumeButtons({ paused: stored.paused === true }),
          );
          const res = await ctx.say({ ...msg, channel: ev.channel });
          ctx.result.posted.push({
            channel: ev.channel ?? '',
            ts: res.ts ?? '',
            kind: 'sync:invited_transcript',
            payload: msg,
          });
        } else if (ev.callback_id) {
          const { invitedMessage } = await import('./strings.js');
          const imsg = invitedMessage(`<@${ev.inviter}|${name}>`);
          const res = await ctx.say({ ...imsg, channel: ev.channel });
          ctx.result.posted.push({
            channel: ev.channel ?? '',
            ts: res.ts ?? '',
            kind: 'sync:invited',
            payload: imsg,
          });
        }
      }
      await updateChannel(ctx, ev.channel);
      return;
    }
    case 'channel_unarchive': {
      const stored = await getClassicChannelBySlackId(ctx.db, ev.channel ?? '');
      if (stored?.isWordhopChannel && cfg.botUserId) {
        // Verbatim: re-invite the bot, then leave — clears the archived state
        // without lingering membership.
        await ctx.api(ctx.install.installerUserToken ?? ctx.install.botToken, 'conversations.invite', {
          channel: stored.slackChannelId,
          users: cfg.botUserId,
        });
        await ctx.api(ctx.install.installerUserToken ?? ctx.install.botToken, 'conversations.leave', {
          channel: stored.slackChannelId,
        });
      }
      await updateChannel(ctx, ev.channel);
      return;
    }
    case 'team_join': {
      // Legacy stores the user doc; our port resolves profiles via users.info
      // on demand — verbatim no-op.
      return;
    }
    default: {
      // channel_archive, channel_marked, channel_history_changed,
      // member_left_channel, channel_rename, channel_created → updateChannel.
      await updateChannel(ctx, ev.channel);
    }
  }
}

// updateChannel (7588-7613): conversations.info → conversations.members →
// save the channel doc. Our row persists name only (members resolved via
// conversations.members on demand).
async function updateChannel(ctx: Ctx, channelId?: string): Promise<void> {
  if (!channelId) return;
  const res = await ctx
    .api<{ channel?: { id?: string; name?: string } }>(ctx.install.botToken, 'conversations.info', {
      channel: channelId,
    })
    .catch(() => ({}) as { channel?: { id?: string; name?: string } });
  const name = res.channel?.name;
  if (!name) return;
  const stored = await getClassicChannelBySlackId(ctx.db, channelId);
  if (!stored || stored.name === name) return;
  await saveClassicChannel(ctx.db, {
    installationId: ctx.install.id,
    slackChannelId: channelId,
    sourceChannel: stored.sourceChannel,
    name,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

// youSaid (slack_bot.js 6257-6303): post the clicked value AS the member
// (their name + avatar), verbatim.
async function youSaid(ctx: Ctx, message: SlackInbound, value?: string | null): Promise<void> {
  const text =
    value ??
    message.actions?.[0]?.value ??
    message.actions?.[0]?.selected_options?.[0]?.value ??
    '';
  const ures = await ctx.api<{ user?: any }>(ctx.install.botToken, 'users.info', {
    user: message.user,
  }).catch(() => ({} as { user?: any }));
  const u = ures.user ?? {};
  const username = (u.name ?? '').toLowerCase();
  const reply: Record<string, unknown> = { text, channel: message.channel, username };
  if (u.profile?.image_72 ?? u.profile?.image_48) {
    reply.icon_url = u.profile.image_72 ?? u.profile.image_48;
  } else {
    reply.icon_emoji = u.profile?.status_emoji;
  }
  const res = await ctx.say(reply);
  ctx.result.posted.push({ channel: message.channel, ts: res.ts ?? '', kind: 'youSaid' });
  // the echo becomes the incoming turn — meta-bot detect + dispatch
  await classicIncoming(ctx, {
    text,
    channel: message.channel,
    ts: res.ts,
    team: message.team,
    user: message.user,
    callback_event: message.callback_event,
    trigger_id: message.trigger_id,
  });
}

async function buttonClicked(
  ctx: Ctx,
  message: SlackInbound,
  _channel: unknown,
): Promise<void> {
  await youSaid(ctx, message, null);
}

// botReplyInteractive (8786-8804) — POST response_url replace_original.
async function botReplyInteractive(
  ctx: Ctx,
  message: SlackInbound,
  reply: { text?: string; attachments?: any[] },
): Promise<void> {
  const body = { ...reply, replace_original: true };
  if (ctx.dry || !message.response_url) {
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'replyInteractive', payload: body });
    return;
  }
  await fetch(message.response_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => ctx.result.errors.push(`replyInteractive: ${String(e)}`));
  ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'replyInteractive' });
}

// Dialog submissions (slack_bot.js 1541-1810) — each maps onto an
// incoming() turn or an agent update + a follow-up event.
async function handleClassicDialogSubmission(
  ctx: Ctx,
  callbackId: string,
  message: SlackInbound,
): Promise<void> {
  const submission = message.submission ?? {};
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  const base: SlackInbound = {
    channel: message.channel,
    user: message.user,
    team: message.team,
    trigger_id: message.trigger_id,
    type: 'message',
  };

  if (callbackId === 'subscribe_to_plan') {
    await classicIncoming(ctx, { ...base, text: submission.plans });
    return;
  }
  if (callbackId === 'agent_name') {
    // incoming with AgentNamed, then createDialogFlowAgents → the Google
    // OAuth leg isn't migrated → AgentCreated/AgentCreatedError path records.
    await classicIncoming(ctx, {
      ...base,
      text: submission.agent_name,
      event: 'AgentNamed',
    });
    ctx.result.suppressed.push({
      channel: message.channel,
      reason: 'agent_name dialog: createDialogFlowAgents needs user Google OAuth link',
    });
    return;
  }
  if (callbackId === 'bot_name') {
    await classicIncoming(ctx, {
      ...base,
      text: submission.bot_name,
      event: JSON.stringify({
        name: 'SaveCustomBotName',
        data: { bot_name: submission.bot_name },
      }),
    });
    return;
  }
  if (callbackId.startsWith('modify_bot:')) {
    const clientKey = callbackId.substring(11);
    const { agents } = await import('../../db/schema.js');
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
      .limit(1);
    if (agent) {
      // df_agents select → getDialogFlowAgent(team, value) attaches the
      // member-OAuth'd agent + creds — no member Google link in the new stack.
      if (submission.df_agents) {
        ctx.result.suppressed.push({
          channel: message.channel,
          reason: 'modify_bot df_agents: user Google OAuth link not migrated',
        });
      }
      const meta = { ...(agent.metadata as Record<string, unknown>) };
      const update: Record<string, unknown> = {};
      let newName: string | undefined;
      if (submission.bot_name != null && submission.bot_name !== agent.name) {
        newName = submission.bot_name;
      }
      const codeLang = submission.code_lang;
      if (codeLang === 'Manychat' || codeLang == null) {
        if (submission.token) meta.manychat_token = submission.token.trim();
        if (codeLang) meta.code_lang = 'manychat';
      } else if (codeLang === 'Chatfuel') {
        meta.code_lang = 'chatfuel';
        if (submission.token) meta.chatfuel_token = submission.token.trim();
        if (submission.chatfuel_botid) meta.chatfuel_botid = submission.chatfuel_botid.trim();
      } else if (codeLang === 'Only Dialogflow') {
        meta.code_lang = 'dialogflow';
      } else if (codeLang === 'Node.js') {
        meta.code_lang = 'npm';
      } else if (codeLang?.toLowerCase() === 'botcopy') {
        meta.code_lang = 'botcopy';
      } else {
        meta.code_lang = codeLang.toLowerCase();
      }
      if (submission.fb_app_id != null) meta.fb_app_id = submission.fb_app_id;
      if (submission.access_token != null) meta.access_token = submission.access_token;
      if (submission.fb_user_access_token != null) {
        meta.fb_user_access_token = submission.fb_user_access_token;
      }
      await ctx.db
        .update(agents)
        .set({ metadata: meta, ...(newName ? { name: newName } : {}) })
        .where(eq(agents.id, agent.id));
      if (newName) {
        const { getClassicPrefs, setMemberDocSettings, DM_SENTINEL } = await import('./store.js');
        const doc: any = message.user
          ? await getClassicPrefs(ctx.db, ctx.install.id, message.user, DM_SENTINEL)
          : {};
        doc.bot_context = { name: newName, client_key: clientKey };
        doc.bot_name = newName;
        await setMemberDocSettings(ctx.db, ctx.install.id, message.user ?? '', doc);
      }
    }
    await classicIncoming(ctx, { ...base, text: 'Settings', event: 'Settings' });
    return;
  }
  if (callbackId === 'send_intent') {
    // Verbatim (1778): sendToUser(bot, message, null, submission.intent_id).
    if (submission.intent_id) {
      await sendToUser(ctx, message, message.actions?.[0], {
        txt: null,
        intentId: submission.intent_id,
      });
    }
    return;
  }
  if (callbackId === 'pause_modal') {
    const duration = submission.custom_duration || submission.duration;
    if (duration == null) return;
    const src = channel?.sourceChannel;
    if (!src) return;
    const conv = await conversationForSource(ctx, src);
    if (!conv) return;
    const userRow = await slackUserToRow(ctx, message.user);
    if (conv.state !== 'human') await takeover(ctx.db, ctx.install.workspaceId, conv.id, userRow);
    await ctx.db
      .update(conversations)
      .set({ humanSince: new Date(), resumeWarnedAt: null, pauseMinutes: Number(duration) })
      .where(eq(conversations.id, conv.id));
    await saveClassicChannel(ctx.db, {
      installationId: ctx.install.id,
      sourceChannel: src,
      paused: true,
      shouldProcessTranscript: true,
      lastAgentTs: new Date(),
    });
    ctx.result.posted.push({ channel: message.channel, ts: '', kind: 'dialog:pause_modal' });
    return;
  }
  ctx.result.suppressed.push({ channel: message.channel, reason: `dialog unhandled: ${callbackId}` });
}

async function conversationForSource(
  ctx: Ctx,
  sourceChannel: string,
): Promise<typeof conversations.$inferSelect | undefined> {
  const [conv] = await ctx.db
    .select()
    .from(conversations)
    .where(sql`${conversations.externalId} LIKE ${'%:' + sourceChannel}`)
    .limit(1);
  return conv;
}

// Slack user id → users row for takeover/humanReply. Falls back to a
// workspace-scoped synthetic operator when the Slack user isn't a member —
// legacy relays regardless of who's typing in the j-channel.
async function slackUserToRow(
  ctx: Ctx,
  slackUserId?: string,
): Promise<typeof users.$inferSelect> {
  if (slackUserId) {
    const [u] = await ctx.db.select().from(users).where(eq(users.slackUserId, slackUserId)).limit(1);
    if (u) return u;
  }
  const [u] = await ctx.db
    .select()
    .from(users)
    .where(eq(users.email, `slack.${ctx.install.teamId}@janis.local`))
    .limit(1);
  if (u) return u;
  const [created] = await ctx.db
    .insert(users)
    .values({
      email: `slack.${ctx.install.teamId}@janis.local`,
      name: 'Slack operator',
      slackUserId: slackUserId ?? null,
    })
    .returning();
  return created;
}
