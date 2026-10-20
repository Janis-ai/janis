// trainingCallbacks.ts — the interactive-message callback tree ported from
// slack_bot.js 4249-5473. Every menu mutation re-renders via
// writeTrainAttachments and chat.update's the original message; DF writes go
// through dfIntents (v1-doc ops → v2 REST). Verbatim behaviors preserved:
//   - pagination ids read actions[0].value OR selected_options[0].value
//   - intentId always re-derived from the ORIGINAL message's reply_type
//     attachment (getIntentIdFromMessage), never from the click payload
//   - "No follow-up" mutates the existing attachment selection in place
//   - reply_type "done" flips editMode off + suggestionMode on
//   - detect_intent pulls contexts from the latest stored 'in' reply and
//     queries with sessionId `${channel}suggest`
//   - intent_selection reject removes the userSays then re-detects so the
//     menu lands on whatever the phrase matches next
//   - &gt;/&lt; unescaping + null-text normalization on attachment mutations
import { and, eq, sql } from 'drizzle-orm';
import { conversations, messages } from '../../db/schema.js';
import { makeMessageFromApiAi } from './dfRender.js';
import {
  addFollowUpIntent,
  addUserSaysToIntent,
  deleteIntent,
  findApiAiResponse,
  findIntent,
  modifyIntent,
  removeQuickReply,
  removeResponseToIntent,
  removeUserSaysToIntent,
  trainApiAi,
  type AgentDf,
} from './dfIntents.js';
import { getActionsMenu, getIntentIdFromMessage, getTsFromMessage, writeTrainAttachments } from './training.js';
import { getClassicChannelBySlackId, resolveAgentDf } from './store.js';
import type { ClassicCtx } from './types.js';

// ── training.js message scanners (verbatim) ───────────────────────────────

export function isInEditMode(message: any): boolean {
  let editMode = false;
  if (message.attachments) {
    for (const attachment of message.attachments) {
      if (attachment.callback_id === 'reply_type') {
        for (const action of attachment.actions ?? []) {
          if (action.value === 'done') {
            editMode = true;
            break;
          }
        }
      }
    }
  }
  return editMode;
}

function getFirstAttachmentDetails(message: any): { title: string } {
  let title = '';
  if (message.attachments) {
    title = message.attachments[0]?.title;
  }
  if (title == null || title === '') title = message.text;
  return { title };
}

/** getTrainingOptions (slack_bot.js 5548-5674) — reconstructs menu state from
 *  the original message's attachments: pagination labels, edit mode, the
 *  currently-selected user_says_type and reply_type, intentId, ts. */
export function getTrainingOptions(message: any, channel: any, userSays: string | null, meta: any): any {
  let oldResponsesPageLabel: number | undefined;
  let oldUserssayPageLabel: number | undefined;
  let editMode = false;
  let details: any = { intentId: 'new' };
  let replyType = 'responses';
  let userSaysType: string | null = null;
  let ts: number | null = null;

  if (message.original_message) {
    const oldAttachments = message.original_message.attachments;
    if (oldAttachments) {
      for (const attachment of oldAttachments) {
        if (attachment.actions) {
          for (const action of attachment.actions) {
            if (action.name === 'responses_page_label') oldResponsesPageLabel = parseInt(action.value);
            if (action.name === 'userssay_page_label') oldUserssayPageLabel = parseInt(action.value);
          }
        }
        if (attachment.callback_id === 'user_says_type') {
          if (attachment.actions != null) {
            const action = attachment.actions[0];
            if (action?.selected_options) {
              userSaysType = action.selected_options[0].value;
            }
          }
        }
      }
      editMode = isInEditMode(message.original_message);
      const attachment = oldAttachments[oldAttachments.length - 2];
      if (message.callback_id === 'user_says_type' && message.actions[0].selected_options) {
        userSaysType = message.actions[0].selected_options[0].value;
      }
      if (message.callback_id === 'reply_type' && message.actions[0].selected_options) {
        replyType = message.actions[0].selected_options[0].value;
      } else if (attachment && attachment.callback_id === 'reply_type') {
        if (attachment.actions != null) {
          const action = attachment.actions[0];
          if (action?.selected_options) {
            replyType = action.selected_options[0].value;
          }
        }
      }
      details = getFirstAttachmentDetails(message.original_message);
      ts = getTsFromMessage(message.original_message);
    }
  }
  const responsesPage = oldResponsesPageLabel;
  const userssayPage = oldUserssayPageLabel;
  const suggestionMode = !editMode;

  let lang: string | null = null;
  if (meta?.lang) lang = meta.lang;
  else if (channel.lang) lang = channel.lang;

  const options: any = {
    responses_page: responsesPage,
    userssay_page: userssayPage,
    client_key: channel.clientKey ?? channel.client_key,
    editMode,
    suggestionMode,
    reply_type: replyType,
    user_says_type: userSaysType,
    userSays,
    intentId: details.intentId,
    lang,
    ts,
    is_chatfuel: meta?.is_chatfuel === true,
    is_manychat: meta?.is_manychat === true,
    is_training_channel: channel.isTrainingChannel === true,
  };
  if (details.title) {
    if (details.title === 'Intents:' || details.title === 'Manage other intents') {
      delete options.userSays;
    }
  } else {
    delete options.userSays;
  }
  return options;
}

// ── dispatcher ─────────────────────────────────────────────────────────────

/** Returns true when the callback id belongs to the training-menu tree —
 *  including DF-bound ids that get recorded as suppressed when creds are
 *  absent. Unknown ids return false so the caller can record them. */
export async function handleTrainingCallback(
  ctx: ClassicCtx,
  callbackId: string,
  message: any,
): Promise<boolean> {
  const action = message.actions?.[0] ?? {};
  const channel = await getClassicChannelBySlackId(ctx.db, message.channel);
  if (!channel) return false;

  const resolved = channel.clientKey ? await resolveAgentDf(ctx, channel.clientKey) : null;
  const df: AgentDf | null = resolved ? { project: resolved.project, sa: resolved.sa } : null;
  const meta = ((resolved?.agent.metadata ?? {}) as Record<string, unknown>);
  const agentLang = resolved?.lang;

  // Thread userSays: legacy reads conversations.replies — when the first
  // reply is a plain text (no menu attachments) it becomes the typed input.
  let txt: string | null = null;
  if (message.original_message?.thread_ts) {
    const replies = await ctx.api<{ messages?: any[] }>(ctx.install.botToken, 'conversations.replies', {
      channel: message.channel,
      ts: message.original_message.thread_ts,
    });
    const msgs = replies.messages ?? [];
    if (msgs[1]?.attachments?.[0]?.actions == null) {
      txt = msgs[0]?.text ?? null;
    }
  }

  const options = getTrainingOptions(message, channel, txt, { ...meta, lang: meta.lang ?? agentLang });

  const updateMenu = async (intentOrId: any, suppressReason?: string): Promise<void> => {
    const original = message.original_message;
    if (!original?.ts) {
      ctx.result.suppressed.push({ channel: message.channel, reason: `callback ${callbackId}: no original_message` });
      return;
    }
    let intent = intentOrId;
    if (intentOrId === 'new' || intentOrId == null) {
      intent = { id: 'new' };
    } else if (typeof intentOrId === 'string') {
      if (!df) {
        ctx.result.suppressed.push({ channel: message.channel, reason: suppressReason ?? `callback ${callbackId}: no df creds` });
        return;
      }
      intent = await findIntent(df, intentOrId);
      if (!intent) intent = { id: 'new' };
    }
    const menu = writeTrainAttachments(intent, options);
    await ctx.api(ctx.install.botToken, 'chat.update', {
      ts: original.ts,
      channel: message.channel,
      text: menu.text,
      attachments: menu.attachments,
    });
    ctx.result.posted.push({ channel: message.channel, ts: original.ts, kind: `callback:${callbackId}` });
  };

  /** Verbatim attachment-mutation update — used by "No follow-up",
   *  quick_reply_menu_callback, and the reply_type select path: set the
   *  selected option on the clicked attachment, unescape >/<, null→'' text,
   *  then chat.update with the SAME original text/attachments. */
  const updateOriginalAttachments = async (): Promise<void> => {
    const original = message.original_message;
    if (!original?.attachments) return;
    const attachment = original.attachments[message.attachment_id - 1];
    if (attachment == null || attachment.actions == null) return;
    if (action.selected_options == null) return;
    const selectedValue = action.selected_options[0].value;
    attachment.actions[0].selected_options = [{ text: selectedValue, value: selectedValue }];
    original.attachments[message.attachment_id - 1] = attachment;
    const newAttachments = unescapeAttachments(original.attachments);
    await ctx.api(ctx.install.botToken, 'chat.update', {
      ts: original.ts,
      channel: message.channel,
      text: original.text,
      attachments: newAttachments,
    });
    ctx.result.posted.push({ channel: message.channel, ts: original.ts, kind: `callback:${callbackId}` });
  };

  switch (callbackId) {
    case 'responses_page': {
      if (action.selected_options == null) options.responses_page = action.value;
      else options.responses_page = action.selected_options[0].value;
      await updateMenu(getIntentIdFromMessage(message.original_message));
      return true;
    }
    case 'userssay_page': {
      if (action.selected_options == null) options.userssay_page = action.value;
      else options.userssay_page = action.selected_options[0].value;
      await updateMenu(getIntentIdFromMessage(message.original_message));
      return true;
    }
    case 'detect_intent': {
      if (options.userSays == null) options.userSays = txt;
      if (!df) {
        ctx.result.suppressed.push({ channel: message.channel, reason: 'callback detect_intent: no df creds' });
        return true;
      }
      const lastReply = await latestInReply(ctx, channel);
      if (lastReply?.result?.contexts) options.contexts = lastReply.result.contexts;
      const body = await findApiAiResponse(df, `${message.channel}suggest`, options);
      if (body?.result?.fulfillment) {
        const intentId = body.result.metadata?.intentId;
        await updateMenu(intentId ?? { id: 'new' });
      }
      return true;
    }
    case 'add_followup': {
      const intentId = getIntentIdFromMessage(message.original_message);
      const selectedValue = action.selected_options?.[0]?.value;
      if (selectedValue === 'No follow-up') {
        await updateOriginalAttachments();
        return true;
      }
      if (!df) {
        ctx.result.suppressed.push({ channel: message.channel, reason: 'callback add_followup: no df creds' });
        return true;
      }
      const intent = await addFollowUpIntent(df, intentId, selectedValue, options.client_key);
      options.editMode = false;
      options.suggestionMode = true;
      options.reply_type = 'responses';
      delete options.userSays;
      await updateMenu(intent);
      return true;
    }
    case 'quick_reply_menu_callback': {
      const intentId = getIntentIdFromMessage(message.original_message);
      if (action.value === 'delete' && options.editMode) {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback quick_reply_menu_callback: no df creds' });
          return true;
        }
        const attachment = message.original_message?.attachments?.[message.attachment_id - 1];
        const selectedValue = attachment?.actions?.[0]?.selected_options?.[0]?.value;
        const intent = await findIntent(df, intentId);
        if (intent) {
          const updated = await removeQuickReply(df, intent, selectedValue);
          await updateMenu(updated);
        }
        return true;
      }
      await updateOriginalAttachments();
      return true;
    }
    case 'user_says_type': {
      await updateMenu(getIntentIdFromMessage(message.original_message));
      return true;
    }
    case 'reply_type': {
      const actionName = action.selected_options == null ? action.value : action.selected_options[0].value;
      if (actionName === 'edit') {
        options.editMode = true;
        await updateMenu(getIntentIdFromMessage(message.original_message));
        return true;
      }
      if (actionName === 'done') {
        options.editMode = false;
        options.suggestionMode = true;
        options.reply_type = 'responses';
        await updateMenu(getIntentIdFromMessage(message.original_message));
        return true;
      }
      if (actionName === 'createnew' || (actionName?.length > 10 && actionName.substring(0, 9) === 'createnew')) {
        await updateMenu({ id: 'new', from_menu: true });
        return true;
      }
      if (actionName === 'suggested_response') {
        options.editMode = false;
        options.suggestionMode = true;
        await updateMenu(getIntentIdFromMessage(message.original_message));
        return true;
      }
      if (actionName === 'manage_intents') {
        options.intentId = 'new';
        options.userSays = '';
        await updateMenu({ id: 'new' });
        return true;
      }
      if (actionName?.substring(0, 4) === 'raw:') {
        const stored = await replyByTs(ctx, channel, parseFloat(actionName.substring(4)));
        if (stored?.reply) {
          options.raw = typeof stored.reply === 'string' ? stored.reply : JSON.stringify(stored.reply);
          options.reply_type = 'responses';
          await updateMenu(getIntentIdFromMessage(message.original_message));
        }
        return true;
      }
      // Reply-method select (responses/quickreply/payload/chatfuel/…):
      // getActionsMenu produces the pair attachment + selected option;
      // the pair is spliced into the original attachments and re-posted.
      if (action.selected_options == null) return true;
      const original = message.original_message;
      if (!original?.attachments) return true;
      const attachment = original.attachments[message.attachment_id - 1];
      if (attachment == null || attachment.actions == null) return true;
      const firstAction = attachment.actions[0];
      const actionMenuObject = getActionsMenu(
        action.selected_options[0].value,
        options,
        original,
        attachment,
      );
      if (firstAction.selected_options && firstAction.selected_options.length > 0) {
        firstAction.selected_options[0] = actionMenuObject.selected_option;
      }
      original.attachments[message.attachment_id] = actionMenuObject.attachment;
      original.attachments[message.attachment_id - 1] = attachment;
      const newAttachments = unescapeAttachments(original.attachments);
      await ctx.api(ctx.install.botToken, 'chat.update', {
        ts: original.ts,
        channel: message.channel,
        text: original.text,
        attachments: newAttachments,
      });
      ctx.result.posted.push({ channel: message.channel, ts: original.ts, kind: `callback:${callbackId}` });
      return true;
    }
    case 'intent_response': {
      const intentId = getIntentIdFromMessage(message.original_message);
      if (action.name === 'delete') {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback intent_response: no df creds' });
          return true;
        }
        const intent = await findIntent(df, intentId);
        if (intent) {
          const responseToRemove = message.original_message?.attachments?.[message.attachment_id - 1]?.fields?.[0]?.value;
          const updated = await removeResponseToIntent(df, intent, responseToRemove, options.user_says_type);
          await updateMenu(updated);
        }
        return true;
      }
      if (action.name === 'suggested') {
        // Post the rendered stored reply as the bot — verbatim
        // sendMessageAsBot intent_response branch.
        const ts = getTsFromMessage(message.original_message);
        const stored = ts != null ? await replyByTs(ctx, channel, ts) : null;
        if (!stored?.reply) return true;
        const parsed = typeof stored.reply === 'string' ? safeJsonParse(stored.reply) : stored.reply;
        const data = makeMessageFromApiAi(parsed, false);
        if ((data.text == null || data.text === '') && (!data.attachments || data.attachments.length === 0)) {
          return true;
        }
        await ctx.say({
          text: data.text ?? ' ',
          attachments: data.attachments ?? [],
          channel: message.channel,
          username: channel.name,
          icon_emoji: ':robot_face:',
        });
        options.reply_type = 'responses';
        return true;
      }
      return true;
    }
    case 'intent_user_says': {
      if (action.name === 'delete') {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback intent_user_says: no df creds' });
          return true;
        }
        const intentId = getIntentIdFromMessage(message.original_message);
        const intent = await findIntent(df, intentId);
        if (intent) {
          const userSaysToRemove = message.original_message?.attachments?.[message.attachment_id - 1]?.fields?.[0]?.value;
          const updated = await removeUserSaysToIntent(df, intent, userSaysToRemove);
          await updateMenu(updated);
        }
      }
      return true;
    }
    case 'followup_list':
    case 'followup_nav': {
      let intentId: string;
      if (action.selected_options) intentId = action.selected_options[0].value;
      else intentId = action.value;
      delete options.userSays;
      await updateMenu(intentId === 'new' ? { id: 'new', from_menu: true } : intentId);
      return true;
    }
    case 'intent_selection': {
      const intentId = getIntentIdFromMessage(message.original_message);
      if (action.name === 'manage_intent_list') {
        await updateMenu(action.selected_options ? action.selected_options[0].value : action.value);
        return true;
      }
      if (action.name === 'approve') {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback intent_selection: no df creds' });
          return true;
        }
        const intent = await findIntent(df, intentId);
        if (intent) {
          const updated = await addUserSaysToIntent(df, intent, options.userSays);
          await updateMenu(updated);
        }
        return true;
      }
      if (action.name === 'find_other_intent') {
        await updateMenu({ id: 'new' });
        return true;
      }
      if (action.name === 'delete') {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback intent_selection delete: no df creds' });
          return true;
        }
        await deleteIntent(df, intentId);
        if (options.userSays == null) {
          await updateMenu({ id: 'new' });
          return true;
        }
        await redetectMenu(df, message.channel, options, updateMenu);
        return true;
      }
      if (action.name === 'reject') {
        if (!intentId) return true;
        if (intentId === 'new') return true;
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback intent_selection reject: no df creds' });
          return true;
        }
        const intent = await findIntent(df, intentId);
        if (intent) {
          await removeUserSaysToIntent(df, intent, options.userSays);
          await redetectMenu(df, message.channel, options, updateMenu);
        }
        return true;
      }
      return true;
    }
    case 'send_to_user': {
      // (5068-5115): 'suggested' picks the dialog-free path — the thread's
      // first customer message + getIntentIdFromMessage → sendToUser.
      if (action.name === 'suggested') {
        const { sendToUser } = await import('./relay.js');
        await sendToUser(ctx, message, action);
      }
      return true;
    }
    case 'quick_reply_callback': {
      // Non-wordhop-channel quick-reply click (j-channel training surface):
      // detect the intent for the clicked reply, then post "You clicked:"
      // + the training menu + the bot's rendered response.
      if (channel.isWordhopChannel) return false; // relay path handled it
      const quickreply = action.value;
      options.userSays = quickreply;
      if (!df) {
        ctx.result.suppressed.push({ channel: message.channel, reason: 'callback quick_reply_callback: no df creds' });
        return true;
      }
      const body = await findApiAiResponse(df, message.channel, options);
      if (!body?.result?.fulfillment) return true;
      const intentId = body.result.metadata?.intentId;
      let menu: any;
      if (intentId == null) {
        menu = writeTrainAttachments({ id: 'new' }, options);
      } else {
        const intent = await findIntent(df, intentId);
        menu = writeTrainAttachments(intent ?? { id: 'new' }, options);
      }
      const res = await ctx.say({ channel: channel.slackChannelId, text: quickreply, username: 'You clicked:' });
      if (res.ts) {
        await ctx.say({
          channel: channel.slackChannelId,
          thread_ts: res.ts,
          text: menu.text,
          attachments: menu.attachments,
        });
        const data: any = makeMessageFromApiAi(body, true, false, meta as any);
        if (!((data.text == null || data.text === '') && (data.attachments ?? []).length === 0)) {
          if (channel.name) {
            data.username = channel.name;
            data.icon_emoji = ':robot_face:';
          }
          await ctx.say({ ...data, channel: channel.slackChannelId });
        }
      }
      ctx.result.posted.push({ channel: message.channel, ts: res.ts ?? '', kind: 'callback:quick_reply_callback' });
      return true;
    }
    default:
      if (action.name === 'manage_intent_list') {
        const intentId = action.selected_options ? action.selected_options[0].value : action.value;
        await updateMenu(intentId === 'new' ? { id: 'new', from_menu: true } : intentId);
        return true;
      }
      if (action.name === 'createnew' || (action.name?.length > 10 && action.name.substring(0, 9) === 'createnew')) {
        if (!df) {
          ctx.result.suppressed.push({ channel: message.channel, reason: 'callback createnew: no df creds' });
          return true;
        }
        const modifiedIntent = await trainApiAi(df, {
          input: options.userSays ?? '',
          userSays: options.userSays,
          clientKey: options.client_key,
          isOneclick: meta.is_oneclick === true,
        });
        if (modifiedIntent) await updateMenu(modifiedIntent);
        return true;
      }
      return false;
  }
}

// ── channelTrain — the typed-reply training path (slack_bot.js ambient,
//   2252-2306 → training.js channelTrain 1353-1450 + updateTrainingUI) ─────

/** Ambient thread reply in a j-/training channel. Returns true when the
 *  channelTrain branch ran — legacy's condition is `thread_ts && DF creds`;
 *  without creds the caller falls through to the relay/else chain. */
export async function channelTrainAmbient(
  ctx: ClassicCtx,
  message: any,
  channel: any,
): Promise<boolean> {
  const resolved = channel.clientKey ? await resolveAgentDf(ctx, channel.clientKey) : null;
  if (!resolved) return false;
  const df: AgentDf = { project: resolved.project, sa: resolved.sa };
  const meta = (resolved.agent.metadata ?? {}) as Record<string, unknown>;

  const replies = await ctx.api<{ messages?: any[] }>(ctx.install.botToken, 'conversations.replies', {
    ts: message.thread_ts,
    channel: message.channel,
  });
  const msgs = replies.messages ?? [];
  if (msgs.length === 0) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'channelTrain: no replies' });
    return true;
  }

  let lastTrainingBlock: any;
  const firstMessage = msgs[0];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.attachments) {
      for (let a = m.attachments.length - 1; a >= 0; a--) {
        const attachment = m.attachments[a];
        if (attachment.callback_id === 'reply_type' || attachment.callback_id === 'intent_selection') {
          lastTrainingBlock = m;
          break;
        }
      }
    }
    if (lastTrainingBlock) break;
  }

  let txt = message.text;
  if (lastTrainingBlock) {
    message.original_message = lastTrainingBlock;
    txt = firstMessage.text;
  }
  if (msgs.length > 1) {
    const headerMessage = msgs[1];
    if (headerMessage?.attachments && headerMessage.attachments[0].actions == null) {
      txt = null;
    }
  }

  const options = getTrainingOptions(message, channel, txt, { ...meta, lang: meta.lang ?? resolved.lang });
  await channelTrain(ctx, message, msgs, options, df, meta, resolved.lang);
  return true;
}

/** channelTrain — decide the mutation from the selected trainingType on the
 *  last menu, apply it to the intent (or create one), then updateTrainingUI. */
async function channelTrain(
  ctx: ClassicCtx,
  message: any,
  msgs: any[],
  options: any,
  df: AgentDf,
  meta: Record<string, unknown>,
  agentLang?: string,
): Promise<void> {
  const userSays = msgs[0]?.text;
  let lastTrainingBlock: any;
  let intentId: string | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.attachments) {
      for (let a = m.attachments.length - 1; a >= 0; a--) {
        const attachment = m.attachments[a];
        if (attachment.callback_id === 'reply_type' || attachment.callback_id === 'intent_selection') {
          lastTrainingBlock = m;
          intentId = getIntentIdFromMessage(lastTrainingBlock);
          break;
        }
      }
    }
    if (lastTrainingBlock) break;
  }

  let trainingType: string | undefined;
  if (lastTrainingBlock) {
    options.editMode = isInEditMode(lastTrainingBlock);
    const attachment = lastTrainingBlock.attachments?.[lastTrainingBlock.attachments.length - 2];
    if (attachment?.actions) {
      const act = attachment.actions[0];
      if (act?.selected_options) trainingType = act.selected_options[0].value;
    }
  }

  const updateUI = async (intent: any) =>
    updateTrainingUI(ctx, message, lastTrainingBlock, intent, userSays, options);

  if (intentId && intentId !== 'new') {
    const intent = await findIntent(df, intentId);
    if (!intent) {
      ctx.result.suppressed.push({ channel: message.channel, reason: `channelTrain: intent ${intentId} not found` });
      return;
    }
    if (
      trainingType === 'responses' ||
      trainingType === 'quickreply' ||
      trainingType === 'payload' ||
      trainingType === 'chatfuel' ||
      trainingType === 'manychat'
    ) {
      if (trainingType === 'responses') options.user_says_type = 'text';
      else if (trainingType === 'quickreply') options.user_says_type = 'quickreplies';
      else if (trainingType === 'payload') options.user_says_type = 'payloads';
      else if (trainingType === 'chatfuel') options.user_says_type = 'chatfuelblock';
      else if (trainingType === 'manychat') options.user_says_type = 'manychatflow';
      const modified = await modifyIntent(df, intent, { input: null, reply: message.text, trainingType });
      await updateUI(modified);
    } else if (trainingType === 'followup') {
      await updateUI(intent);
    } else if (trainingType === 'userssay') {
      const modified = await addUserSaysToIntent(df, intent, message.text);
      await updateUI(modified);
    } else {
      await updateUI(intent);
    }
  } else {
    const modified = await trainApiAi(df, {
      input: message.text ?? '',
      userSays: options.userSays,
      clientKey: options.client_key,
      isOneclick: meta.is_oneclick === true,
    });
    if (modified) await updateUI(modified);
  }
}

/** updateTrainingUI — re-render the menu over the last training block,
 *  preserving the trailing attachments when the callback_id still matches,
 *  then delete the typed reply (best-effort: needs the author's token). */
async function updateTrainingUI(
  ctx: ClassicCtx,
  message: any,
  messageToModify: any,
  intent: any,
  userSays: string,
  options: any,
): Promise<void> {
  if (options.userSays) options.userSays = userSays;
  if (messageToModify == null) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'updateTrainingUI: no training block' });
    return;
  }
  const menu = writeTrainAttachments(intent, options);
  const attachment = messageToModify.attachments[messageToModify.attachments.length - 2];
  const newAttachment = menu.attachments[menu.attachments.length - 2];
  if (attachment?.callback_id === newAttachment?.callback_id) {
    menu.attachments[menu.attachments.length - 2] = attachment;
    menu.attachments[menu.attachments.length - 1] = messageToModify.attachments[messageToModify.attachments.length - 1];
  }
  await ctx.api(ctx.install.botToken, 'chat.update', {
    ts: messageToModify.ts,
    channel: message.channel,
    text: menu.text,
    attachments: menu.attachments,
  });
  try {
    await ctx.api(ctx.install.botToken, 'chat.delete', {
      ts: message.ts,
      channel: message.channel,
      as_user: true,
    });
  } catch {
    // verbatim swallows the delete error — bot token can't delete members'
    // messages without chat:write:user; the menu update already landed.
  }
  ctx.result.posted.push({ channel: message.channel, ts: messageToModify.ts, kind: 'callback:channelTrain' });
}

/** The is_training_channel branch of incoming() (slack_bot.js 9775-9854):
 *  detectIntent on the CUSTOMER agent → render as the bot → thread the
 *  training menu under the member's message. */
export async function trainingChannelIncoming(
  ctx: ClassicCtx,
  message: any,
  channel: any,
): Promise<void> {
  const resolved = channel.clientKey ? await resolveAgentDf(ctx, channel.clientKey) : null;
  if (!resolved) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'training channel: no df creds' });
    return;
  }
  const df: AgentDf = { project: resolved.project, sa: resolved.sa };
  const meta = (resolved.agent.metadata ?? {}) as Record<string, unknown>;
  const options: any = {
    client_key: channel.clientKey,
    userSays: message.text,
    suggestionMode: true,
    is_training_channel: true,
    is_chatfuel: meta.is_chatfuel === true,
    is_manychat: meta.is_manychat === true,
    lang: (meta.lang as string) ?? resolved.lang ?? channel.lang,
  };
  const body = await findApiAiResponse(df, message.channel, options);
  const data: any = makeMessageFromApiAi(body, true, false, meta as any);
  if (channel.name && data) {
    data.username = channel.name;
    data.icon_emoji = ':robot_face:';
  }
  if ((data.text != null && data.text !== '') || (data.attachments ?? []).length > 0) {
    await ctx.say({ ...data, channel: message.channel });
  }
  if (body?.result?.fulfillment) {
    const intentId = body.result.metadata?.intentId;
    const intent = intentId == null ? { id: 'new' } : await findIntent(df, intentId);
    const menu = writeTrainAttachments(intent ?? { id: 'new' }, options);
    await ctx.say({
      channel: message.channel,
      thread_ts: message.ts,
      text: menu.text,
      attachments: menu.attachments,
    });
    ctx.result.posted.push({ channel: message.channel, ts: message.ts, kind: 'callback:training_incoming' });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function unescapeAttachments(attachments: any[]): any[] {
  const out: any[] = [];
  for (const attachment of attachments) {
    if (!attachment) continue;
    if (attachment.text == null) attachment.text = '';
    if (attachment.actions) {
      for (const action of attachment.actions) {
        if (action.text === '&gt;') action.text = '>';
        else if (action.text === '&lt;') action.text = '<';
      }
    }
    out.push(attachment);
  }
  return out;
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** findApiAiResponse → re-render whichever intent the userSays matches now
 *  (the intent_selection delete/reject tail, slack_bot.js 5277-5387). */
async function redetectMenu(
  df: AgentDf,
  slackChannelId: string,
  options: any,
  updateMenu: (intentOrId: any) => Promise<void>,
): Promise<void> {
  const body = await findApiAiResponse(df, slackChannelId, options);
  if (!body?.result?.fulfillment) return;
  const intentId = body.result.metadata?.intentId;
  if (intentId == null) {
    await updateMenu({ id: 'new' });
    return;
  }
  const intent = await findIntent(df, intentId);
  if (intent?.fallbackIntent) {
    await updateMenu({ id: 'new' });
    return;
  }
  await updateMenu(intent ?? { id: 'new' });
}

/** getLatestWithParams({client_key, type:'in'}) — latest stored inbound
 *  message's parsed DF reply for this Slack channel's conversation. */
async function latestInReply(ctx: ClassicCtx, channel: any): Promise<any | null> {
  const conv = await conversationForSource(ctx, channel.sourceChannel);
  if (!conv) return null;
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'in')))
    .orderBy(sql`${messages.createdAt} DESC`)
    .limit(1);
  return replyOf(row);
}

/** getWithParams({client_key, 'data.message.ts': ts}) — the stored 'in'
 *  message whose transcript ts matches (raw: link + suggested send). */
async function replyByTs(ctx: ClassicCtx, channel: any, ts: number): Promise<any | null> {
  const conv = await conversationForSource(ctx, channel.sourceChannel);
  if (!conv) return null;
  const [row] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.direction, 'in'),
        sql`CAST(${messages.payload}->'message'->>'ts' AS float8) = ${ts}`,
      ),
    )
    .limit(1);
  return replyOf(row);
}

function replyOf(row: any): any | null {
  const reply = (row?.payload as any)?.message?.reply;
  if (reply == null) return null;
  return typeof reply === 'string' ? safeJsonParse(reply) : reply;
}

async function conversationForSource(ctx: ClassicCtx, sourceChannel: string | null | undefined) {
  if (!sourceChannel) return undefined;
  const [conv] = await ctx.db
    .select()
    .from(conversations)
    .where(sql`${conversations.externalId} LIKE ${'%:' + sourceChannel}`)
    .limit(1);
  return conv;
}
