// Port of the transcript pipeline: getBulkMessages →
// getTranscriptChannelAndProcessBulkMessages → processBulkMessages →
// sendChatMessageResponse / sendBotMessageResponse / sendWarningToChannel /
// sendMessageToChannel / sendFullTranscriptWarning.

import type { ClassicChannelRow, ClassicCtx, LegacyEvent } from './types.js';
import {
  agentIdForClientKey,
  conversationForSource,
  fetchBacklog,
  markProcessed,
  getClassicChannelBySource,
  getClassicChannelBySlackId,
  resolveAgentDf,
  saveClassicChannel,
} from './store.js';
import { getTranscriptChannel } from './channels.js';
import { getUserProfile, removeFormatting } from './profiles.js';
import { makeFbMessage, normalizeTranscriptAttachments } from './attachments.js';
import { pauseResumeButtons } from './buttons.js';

const JANIS_WEBAPP = () => process.env.JANIS_WEBAPP_URL ?? 'https://www.janis.ai';

type PipeCtx = ClassicCtx;

// checkIfMessageDirectedAtBot (slack_bot.js ~6499) — decides whether a stored
// doc renders as a customer line vs a bot line.
export function isDirectedAtBot(message: any, type?: string): boolean {
  const event = message?.event;
  return !!(
    (type === 'in' || type == null) &&
    message?.live == null &&
    message?.channel &&
    message?.bot_id == null &&
    (message?.subtype == null || message.subtype === 'file_share') &&
    message?.actions == null &&
    message?.transcript == null &&
    message?.user !== 'USLACKBOT' &&
    (event === 'direct_message' || event === 'direct_mention' || event == null)
  );
}

// sendChatMessageResponse — the "user said" line into the j-channel.
export async function sendChatMessageResponse(
  ctx: PipeCtx,
  msg: any,
  wordhopChannel: ClassicChannelRow,
): Promise<void> {
  const { out, fileUploads } = normalizeTranscriptAttachments(msg.attachments);
  const userObject = getUserProfile(msg.user_profile ?? msg);
  const message: Record<string, unknown> = {
    channel: wordhopChannel.slackChannelId,
    text: msg.display_text ?? msg.text ?? '',
    transcript: true,
    attachments: out,
    metadata: msg.metadata,
    username: userObject.name,
    // Legacy sent as_user:false to make username/icon apply — the param was
    // removed from the platform (invalid_arguments on non-grandfathered
    // apps); custom username works via chat:write.customize without it.
  };
  if (userObject.image) message.icon_url = userObject.image;
  else message.icon_emoji = userObject.icon_emoji;

  const res = await ctx.say(message);
  if (res.ok && res.ts) {
    ctx.result.posted.push({
      channel: wordhopChannel.slackChannelId,
      ts: res.ts,
      kind: 'transcript:user',
    });
    await saveClassicChannel(ctx.db, {
      installationId: ctx.install.id,
      sourceChannel: wordhopChannel.sourceChannel,
      slackChannelId: wordhopChannel.slackChannelId,
      name: wordhopChannel.name,
      lastMessageTs: res.ts,
    });
    if (msg.menu) {
      // writeTrainThread — the training menu posts as a reply in the thread.
      await ctx.api(ctx.install.botToken, 'chat.postMessage', {
        channel: wordhopChannel.slackChannelId,
        thread_ts: res.ts,
        text: ' ',
        attachments: Array.isArray(msg.menu) ? msg.menu : [msg.menu],
      });
    }
  } else {
    ctx.result.errors.push(`transcript user line failed: ${res.error ?? 'unknown'}`);
  }

  // Legacy uploads media attachments via files.upload as a side-effect.
  for (const f of fileUploads) {
    await ctx.api(ctx.install.botToken, 'files.upload', {
      channels: wordhopChannel.slackChannelId,
      filename: f.filename,
      // url fetch → buffer; kept minimal (Slack accepts 'content' or a stream)
      url: f.url,
    });
  }
}

// sendBotMessageResponse — the "bot said" line. Verbatim quirks:
// `_<@slack_user>_: ` prefix for operator-sent replies, then chat.delete of
// the operator's original j-channel message; post failure → chat.update the
// original with the failure text.
export async function sendBotMessageResponse(
  ctx: PipeCtx,
  msg: any,
  wordhopChannel: ClassicChannelRow,
): Promise<void> {
  const fbMessage = makeFbMessage(msg) as Record<string, unknown>;
  fbMessage.channel = wordhopChannel.slackChannelId;

  let metadata: any = msg.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = null;
    }
  }
  const slackUser = msg.slack_user ?? metadata?.slack_user;
  if (slackUser) {
    fbMessage.text = `_<@${slackUser}>_:  ${fbMessage.text}`;
  }

  const res = await ctx.say(fbMessage);
  if (res.ok && res.ts) {
    ctx.result.posted.push({
      channel: wordhopChannel.slackChannelId,
      ts: res.ts,
      kind: 'transcript:bot',
    });
    if (
      msg.is_thread_broadcast == null &&
      slackUser &&
      metadata?.ts &&
      metadata.broadcast !== true &&
      (msg.agent_team == null || msg.agent_team === ctx.install.teamId) &&
      ctx.install.installerUserToken
    ) {
      await ctx.api(ctx.install.installerUserToken!, 'chat.delete', {
        ts: metadata.ts,
        channel: wordhopChannel.slackChannelId,
      });
    }
  } else {
    ctx.result.errors.push(`bot line failed: ${res.error ?? 'unknown'}`);
    if (msg.ts && ctx.install.installerUserToken) {
      await ctx.api(ctx.install.installerUserToken!, 'chat.update', {
        ts: msg.ts.toFixed(6),
        channel: wordhopChannel.slackChannelId,
        text: `${msg.text} \n _YOUR BOT FAILED TO SEND THIS MESSAGE. ERROR: ${res.error}_`,
      });
    }
  }
}

// dialogflowMessageResponse — same line render + intent/training attachment
// already enriched upstream. The legacy createnew: poll loop is not ported:
// it exists to re-parent the training menu after "create new intent" clicks,
// which the port keeps as a plain threaded menu post.
export async function dialogflowMessageResponse(
  ctx: PipeCtx,
  msg: any,
  wordhopChannel: ClassicChannelRow,
): Promise<void> {
  await sendChatMessageResponse(ctx, msg, wordhopChannel);
}

// sendWarningToChannel — lifecycle posts into a j-channel. Archived → skip.
export async function sendWarningToChannel(
  ctx: PipeCtx,
  channel: ClassicChannelRow,
  message: { text?: string },
  messageType: string,
): Promise<void> {
  if ((channel as any).is_archived) return;
  let text = message.text ?? '';
  if (
    messageType === 'stopped processing channels message' ||
    messageType === 'stopped transcribing channels message'
  ) {
    text = text + channel.sourceChannel;
  } else {
    text =
      text +
      '\n _See my 1-reply to messages you receive and I will help you train your AI_';
  }
  const attachments = [
    pauseResumeButtons({
      paused: channel.paused,
      should_process_transcript: channel.shouldProcessTranscript,
    }),
  ];
  const res = await ctx.say({
    channel: channel.slackChannelId,
    text,
    attachments,
  });
  if (res.ok && res.ts) {
    ctx.result.posted.push({
      channel: channel.slackChannelId,
      ts: res.ts,
      kind: 'lifecycle',
    });
  } else if (!res.ok) {
    ctx.result.errors.push(`lifecycle post failed ${channel.slackChannelId}: ${res.error}`);
  }
}

// sendMessageToChannel — "engage users" broadcast. Never posts into
// transcript channels (verbatim guard).
export async function sendMessageToChannel(
  ctx: PipeCtx,
  channelId: string,
  text: string,
): Promise<void> {
  // Verbatim guard: engage never posts into a transcript channel.
  const jChannel = await getClassicChannelBySlackId(ctx.db, channelId);
  if (jChannel?.isWordhopChannel) {
    ctx.result.suppressed.push({ channel: channelId, reason: 'engage into j-channel' });
    return;
  }
  const res = await ctx.say({
    channel: channelId,
    text,
    attachments: [],
  });
  if (res.ok && res.ts) {
    ctx.result.posted.push({ channel: channelId, ts: res.ts, kind: 'engage' });
  }
}

// getBulkMessages — pulls ≤21 unprocessed rows for the source channel's
// conversation, marks them processed, returns render-ready legacy messages.
// Rejects (returns null) on empty backlog, verbatim.
export async function getBulkMessages(ctx: PipeCtx, msg: LegacyEvent): Promise<any[] | null> {
  const conv = await conversationForSource(
    ctx.db,
    ctx.install.workspaceId,
    String(msg.channel),
    (msg.agent_id as string | undefined) ??
      (await agentIdForClientKey(ctx.db, msg.client_key)),
  );
  if (!conv) return null;
  const docs = await fetchBacklog(ctx.db, conv.id);
  const docIds = docs.slice(0, 20).map((d) => d.id);
  await markProcessed(ctx.db, docIds);

  const out: any[] = [];
  // Legacy emits a "see more" line when the backlog exceeds 20.
  if (docs.length > 20) {
    out.push({
      channel: msg.channel,
      source_team: msg.source_team ?? msg.sourceTeam,
      team: msg.team,
      client_key: msg.client_key,
      bot_name: msg.bot_name,
      apiai_key: msg.apiai_key,
      dialogflow: msg.dialogflow ? true : false,
      team_ids: msg.team_ids,
      text: `To see more than the last 20 messages, click here: ${JANIS_WEBAPP()}/messages/${msg.channel}`,
      docSentiment: { score: 0 },
      attachments: [],
      is_from_janis: true,
    });
  }
  const slice = docs.slice(0, 20).reverse(); // chronological
  for (const doc of slice) {
    const payload = (doc.payload ?? {}) as any;
    const message = {
      ...payload.message,
      text: payload.message?.text ?? doc.text,
      channel: (doc.payload as any)?.message?.channel ?? conv.externalId.split(':').pop(),
      user: payload.message?.user,
      ts: payload.message?.ts ?? doc.createdAt.getTime() / 1000,
      metadata: payload.message?.metadata,
      attachments: payload.message?.attachments,
      user_profile: payload.message?.user_profile ?? conv.userProfile,
      display_text: payload.message?.display_text,
      quick_replies: payload.message?.quick_replies,
      menu: payload.message?.menu,
      reply: payload.message?.reply,
    };
    if (isDirectedAtBot(message, doc.direction)) message.is_from_user = true;
    else if (doc.direction === 'out') message.is_from_user = false;
    out.push(message);
  }
  if (out.length === 0) return null;
  return out;
}

// processBulkMessages — per-message dispatch (verbatim precedence).
export async function processBulkMessages(
  ctx: PipeCtx,
  msg: LegacyEvent,
  wordhopChannel: ClassicChannelRow,
  list: any[],
): Promise<void> {
  // Training-menu enrichment (findApiAiResponseAndWriteAttachment): every
  // 'in' line on a DF-enabled bot gets its "did the bot get it right?" menu
  // in the thread. Resolve the agent's DF creds once per flush.
  let enrich: ((message: any) => Promise<any>) | null = null;
  const clientKey = msg.client_key ?? wordhopChannel.clientKey;
  if (clientKey) {
    const df = await resolveAgentDf(ctx, clientKey);
    if (df) {
      const meta = (df.agent.metadata ?? {}) as Record<string, unknown>;
      const options = {
        client_key: clientKey,
        is_chatfuel: meta.is_chatfuel === true,
        is_manychat: meta.is_manychat === true,
      };
      const { findApiAiResponseAndWriteAttachment } = await import('./training.js');
      const { getIntentV1 } = await import('../dialogflow.js');
      enrich = (message) =>
        findApiAiResponseAndWriteAttachment(message, { ...options }, (intentId) =>
          getIntentV1(df.project, intentId, df.sa, { withFollowups: true }),
        );
    }
  }
  for (const message of list) {
    let metadata: any = message.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    if (metadata != null && metadata.bot !== 'janis' && metadata.broadcast !== true) {
      if (metadata.slack_user) message.slack_user = metadata.slack_user;
      if (metadata.team) message.team = metadata.team;
      if (metadata.ts) message.ts = parseFloat(metadata.ts);
      if (metadata.quick_replies) message.quick_replies = metadata.quick_replies;
      if (metadata.agent_team) message.agent_team = metadata.agent_team;
      await sendBotMessageResponse(ctx, message, wordhopChannel);
    } else if (message.is_from_janis) {
      await sendWarningToChannel(ctx, wordhopChannel, message, 'link to full transcript');
    } else if (message.is_from_user) {
      if (enrich) await enrich(message).catch(() => message);
      await sendChatMessageResponse(ctx, message, wordhopChannel);
    } else if (msg.type === 'dialogflow_message') {
      await dialogflowMessageResponse(ctx, message, wordhopChannel);
    } else {
      await sendBotMessageResponse(ctx, message, wordhopChannel);
    }
  }
}

// getTranscriptChannelAndProcessBulkMessages — the shared tail of
// chat/bot/dialogflow/bulk events.
export async function flushTranscript(
  ctx: PipeCtx,
  msg: LegacyEvent,
  messages?: any[],
): Promise<void> {
  const list = messages ?? (await getBulkMessages(ctx, msg));
  if (!list || list.length === 0) {
    ctx.result.suppressed.push({ channel: String(msg.channel), reason: 'empty transcript backlog' });
    return;
  }
  const channel = await getTranscriptChannel({
    ...ctx,
    sourceChannel: String(msg.channel),
    clientKey: msg.client_key,
    json: msg,
    type: 'chatMessage',
  });
  if (!channel) {
    ctx.result.suppressed.push({ channel: String(msg.channel), reason: 'no transcript channel' });
    return;
  }
  await processBulkMessages(ctx, msg, channel, list);
}

// sendFullTranscriptWarning — 'channel update'/'link to full transcript'.
export async function sendFullTranscriptWarning(
  ctx: PipeCtx,
  msg: LegacyEvent,
  messageType: string,
): Promise<void> {
  const channel = await getTranscriptChannel({
    ...ctx,
    sourceChannel: String(msg.channel),
    clientKey: msg.client_key,
    json: msg,
    type: 'botMessage',
  });
  if (!channel) return;
  await sendWarningToChannel(ctx, channel, { text: msg.text ?? msg.message }, messageType);
}

// Lifecycle channel fan-out ('stopped transcribing…' etc.) — resolves each
// sourceChannel in msg.channels to its j-channel.
export async function lifecycleFanOut(
  ctx: PipeCtx,
  msg: LegacyEvent,
  messageType: string,
): Promise<number> {
  let posted = 0;
  for (const srcId of msg.channels ?? []) {
    const channel = await getClassicChannelBySource(ctx.db, ctx.install.id, String(srcId));
    if (!channel) continue;
    await sendWarningToChannel(ctx, channel, { text: msg.text ?? '' }, messageType);
    posted++;
  }
  if (posted === 0) {
    ctx.result.suppressed.push({ reason: `no transcript channels for ${messageType}` });
  }
  return posted;
}

export { removeFormatting };
