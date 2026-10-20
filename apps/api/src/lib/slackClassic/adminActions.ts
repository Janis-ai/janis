// adminActions.ts — the apiaiResponse admin/onboarding action surface ported
// from slack_bot.js 10892-11869 + its helpers (suggestBot 8816,
// botSettingsMessage 2392-2833, invite*ToIm 9125-9407, manageIntents
// training.js 2866-3152, sendIntentForTranscriptBot 9422-9486).
// Legacy persisted on Mongo channel/user docs; here member state lives on
// slackClassicPrefs (__dm__ sentinel = the DM doc, per-clientKey rows =
// per-bot settings) and workspace bots are agents with
// metadata.legacy_client_key.
import { and, eq, sql } from 'drizzle-orm';
import { agents, slackClassicChannels } from '../../db/schema.js';
import type { ClassicCtx } from './types.js';
import { detectIntentV1 } from '../dialogflow.js';
import { makeMessageFromApiAi } from './dfRender.js';
import { openClassicDialog } from './dialogView.js';

// ── bot list ───────────────────────────────────────────────────────────────

/** wordhopapi.botSubscriptions → bodyObj.response.bots — the workspace's
 *  legacy-linked bots as {name, client_key}. */
export async function botObjsForWorkspace(
  ctx: ClassicCtx,
): Promise<{ name: string; client_key: string }[]> {
  const rows = await ctx.db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, ctx.install.workspaceId));
  return rows
    .map((a) => ({
      name: a.name,
      client_key: (a.metadata as Record<string, unknown> | null)?.legacy_client_key as string,
    }))
    .filter((b) => b.client_key);
}

/** getBotAlertSettings verbatim — finds-or-pushes a {client_key} shell inside
 *  the settings' custom_alerts array. Mutates `settings`. */
export function getBotAlertSettings(settings: any, clientKey: string): any {
  if (settings.custom_alerts == null) settings.custom_alerts = [];
  let botAlertSettings = settings.custom_alerts.find((o: any) => o.client_key === clientKey);
  if (!botAlertSettings) {
    botAlertSettings = { client_key: clientKey };
    settings.custom_alerts.push(botAlertSettings);
  }
  return botAlertSettings;
}

/** saveBotContext verbatim — syncs bot_context {name, client_key} on the doc
 *  from the bot list matching bot_name. Mutates `settings`. */
export function saveBotContext(botObjs: { name: string; client_key: string }[], settings: any): void {
  const arr = botObjs.filter((o) => o.name === settings.bot_name);
  if (settings.bot_context == null) settings.bot_context = {};
  if (arr[0]) {
    settings.bot_context.name = arr[0].name;
    settings.bot_context.client_key = arr[0].client_key;
  }
}

// ── suggestBot (slack_bot.js 8816-8874) ────────────────────────────────────

export function suggestBotMessage(text: string, botObjs: { name: string }[]): any {
  if (botObjs.length === 0) {
    return {
      text,
      callback_id: 'generic_callback',
      attachment_type: 'default',
      actions: [
        { name: 'Add a bot', text: 'Add a bot', type: 'button', value: 'Add a bot' },
        { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
      ],
    };
  }
  const reply: any = {
    text,
    attachments: [
      {
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: '',
        fallback: 'bot selection list',
        color: '#3AA3E3',
        attachment_type: 'default',
        callback_id: 'set_bot',
        actions: [
          { name: 'set_bot', text: 'Select your bot...', type: 'select', options: [] },
          { name: 'Add a bot', text: 'Add a bot', type: 'button', value: 'Add a bot' },
          { name: 'Help', text: 'Help', type: 'button', value: 'Help' },
        ],
      },
    ],
  };
  for (const botObj of botObjs) {
    reply.attachments[0].actions[0].options.push({ text: botObj.name, value: botObj.name });
  }
  return reply;
}

// ── botSettingsMessage (slack_bot.js 2392-2833) — verbatim ─────────────────

const SETTING_PROPS = [
  'logSeverityLevel',
  'userUpsetSeverityLevel',
  'helpNeededSeverityLevel',
  'errorWarningLevel',
  'customAlertSeverityLevel',
] as const;

export function botSettingsMessage(
  botObjs: { name: string; client_key: string }[],
  matchingBot: { name: string; client_key?: string; dialogflow?: unknown; apiai_key?: unknown; alerts?: any } | null,
  page: number,
  type: number,
  settings: any, // the member/channel doc — custom_alerts + severity fields
): any {
  if (type == null) type = 0;
  if (page == null) page = 0;
  if (matchingBot == null) matchingBot = { name: 'All bots' };
  page = parseInt(String(page));

  const data: any = { text: 'Your alert settings for:', attachments: [] };
  const botList: any = {
    mrkdwn_in: ['fields', 'text', 'pretext'],
    text: '',
    title: '',
    fallback: 'bot selection list',
    color: '#009933',
    attachment_type: 'default',
    callback_id: 'set_bot',
    actions: [{ name: 'set_bot', text: 'Select your bot...', type: 'select', options: [] }],
  };
  if (botObjs.length > 1) {
    botList.actions[0].options.push({ text: 'All bots', value: 'All bots' });
  }
  for (const botObj of botObjs) {
    botList.actions[0].options.push({ text: botObj.name, value: botObj.name });
  }
  if (matchingBot) {
    botList.actions[0].selected_options = [{ text: matchingBot.name, value: matchingBot.name }];
  }
  data.attachments.push(botList);

  const channelSettings: Record<string, number> = {};
  for (const prop of SETTING_PROPS) {
    channelSettings[prop] = settings[prop];
    if (
      channelSettings[prop] == null &&
      matchingBot.name !== 'All bots' &&
      settings.bot_context &&
      settings.bot_context.client_key &&
      settings.bot_context.client_key === matchingBot.client_key
    ) {
      channelSettings[prop] = 1;
    } else if (channelSettings[prop] == null) {
      channelSettings[prop] = 0;
    }
  }

  if (matchingBot.name === 'All bots') {
    for (const botObj of botObjs) {
      const botAlertSettings = getBotAlertSettings(settings, botObj.client_key);
      for (const prop of SETTING_PROPS) {
        if (botAlertSettings && botAlertSettings[prop] != null) {
          if (channelSettings[prop] != null && channelSettings[prop] !== botAlertSettings[prop]) {
            channelSettings[prop] = -1;
          } else {
            channelSettings[prop] = botAlertSettings[prop];
          }
        }
      }
    }
    for (const prop of SETTING_PROPS) {
      if (channelSettings[prop] == null) channelSettings[prop] = 0;
    }
  } else {
    const botAlertSettings = getBotAlertSettings(settings, settings.bot_context?.client_key);
    for (const prop of SETTING_PROPS) {
      if (botAlertSettings && botAlertSettings[prop] != null) {
        channelSettings[prop] = botAlertSettings[prop];
      }
      botAlertSettings[prop] = channelSettings[prop];
    }
    // doSave: caller persists `settings` back to the member doc.
  }

  const filterAttachment = (title: string, fallback: string, name: string, level: number, extra?: any) => {
    const attachment: any = {
      mrkdwn_in: ['fields', 'text', 'pretext'],
      title,
      text: '',
      fallback,
      color: '#c4c4c4',
      attachment_type: 'default',
      callback_id: 'filter_alert',
      actions: [
        {
          name,
          text: 'Select alert type...',
          type: 'select',
          options: [
            { text: 'Enabled', value: '1' },
            { text: 'Disabled', value: '0' },
          ],
        },
      ],
    };
    if (extra) attachment.actions.push(extra);
    attachment.actions[0].selected_options = [
      attachment.actions[0].options[Math.abs(level - 1)],
    ];
    return attachment;
  };

  data.attachments.push(
    filterAttachment(':speak_no_evil: No response', 'No response', 'filter_failure', channelSettings.logSeverityLevel),
  );
  data.attachments.push(
    filterAttachment(':warning: Error warnings', 'Error warnings', 'filter_error', channelSettings.errorWarningLevel),
  );
  data.attachments.push(
    filterAttachment(
      ':scream: Negative sentiment (Pro)',
      'Negative sentiment',
      'filter_sentiment',
      channelSettings.userUpsetSeverityLevel,
    ),
  );
  data.attachments.push(
    filterAttachment(
      ':information_desk_person::skin-tone-2: Needs assistance (Pro)',
      'Needs assistance',
      'filter_human',
      channelSettings.helpNeededSeverityLevel,
    ),
  );

  if (matchingBot && (matchingBot.dialogflow || matchingBot.apiai_key || matchingBot.name === 'All bots')) {
    const manageBtn =
      type !== 3 && (matchingBot.dialogflow || matchingBot.apiai_key)
        ? {
            name: 'manage_custom_alerts',
            text: 'Manage',
            type: 'button',
            value: 'manage_custom_alerts',
            style: 'default',
          }
        : undefined;
    data.attachments.push(
      filterAttachment(
        ':bell: Custom alerts (Pro)',
        'Custom alerts',
        'filter_custom',
        channelSettings.customAlertSeverityLevel,
        manageBtn,
      ),
    );

    if (type === 3 && (matchingBot.dialogflow || matchingBot.apiai_key)) {
      data.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: ':point_right: For custom alerts, add a Dialogflow intent to trigger it.',
        title: '',
        fallback: 'Search Intents...',
        color: '#c4c4c4',
        attachment_type: 'default',
        callback_id: 'intent_selection_alerts',
        actions: [
          { name: 'manage_intent_alert', text: 'Search Intents...', type: 'select', data_source: 'external' },
        ],
      });

      const botAlertSettings = getBotAlertSettings(settings, matchingBot.client_key ?? '');
      const alerts = botAlertSettings || matchingBot.alerts || {};
      const intentAlerts = alerts.intents || [];

      const pagingLimit = 10;
      const count = intentAlerts.length;
      let pos = (page + 1) * pagingLimit - pagingLimit;
      if (pos >= count) {
        page = page - 1;
        pos = (page + 1) * pagingLimit - pagingLimit;
      }
      const length = Math.min(count, pos + pagingLimit);
      const pageOptions: any[] = [];
      const lastPage = Math.ceil(count / pagingLimit);
      for (let i = 0; i < lastPage; i++) {
        pageOptions.push({ text: `Page ${i + 1} of ${lastPage}`, value: i });
      }
      const pageSelectedOptions = [{ text: `Page ${page} of ${lastPage}`, value: page - 1 }];
      const color = '#53188d';
      if (lastPage > 1) {
        data.attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          fallback: `Page: ${page + 1}`,
          title: 'Your current custom alerts:',
          fields: [{ short: false, value: '' }],
          callback_id: 'intent_selection_alerts',
          color,
          attachment_type: 'default',
          selected_options: pageSelectedOptions,
          actions: [
            {
              name: 'alert_intent_page_label',
              text: `Page ${page + 1} of ${lastPage}`,
              type: 'select',
              options: pageOptions,
            },
          ],
        });
      } else {
        data.attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          fallback: 'Your current custom alerts:',
          title: 'Your current custom alerts:',
          color,
        });
      }
      for (let i = pos; i < length; i++) {
        const intentAlert = intentAlerts[i];
        if (intentAlert != null) {
          data.attachments.push({
            mrkdwn_in: ['fields', 'text', 'pretext'],
            fallback: 'payload',
            fields: [{ short: false, value: intentAlert.name }],
            callback_id: 'intent_selection_alerts',
            color: 'ccc',
            attachment_type: 'default',
            actions: [
              {
                name: 'delete',
                text: 'X',
                type: 'button',
                value: intentAlert.id,
                style: 'danger',
                confirm: {
                  title: 'Delete',
                  text: 'Permanently delete this alert?',
                  ok_text: 'Yes',
                  dismiss_text: 'Cancel',
                },
              },
            ],
          });
        }
      }
    }
  }
  return data;
}

// ── invite*ToIm + sendInviteMessage (slack_bot.js 9125-9407) ───────────────

const INVITE_TEXT = (userid: string, inviterUserId: string) =>
  `Hi <@${userid}>. <@${inviterUserId}> has asked you to complete an integration` +
  ' of Janis so you can train, monitor, and test AI from Slack. Developers say it only ' +
  'takes a few minutes to drop in Janis code into your bot and it begins working immediately. ';

const INVITED_NOTICE = (name: string) => ({
  text: `:+1: I just invited ${name} and will tell them how to complete the setup. It only takes minutes and begins working immediately.`,
  attachments: [
    {
      title: 'While you wait…',
      text: `Don't want to wait for ${name} to integrate me?  Here are things you can do right away`,
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

export const INVITE_USER_NOT_FOUND =
  'No user was found on your Slack team with that name. Try typing `@` to select from the list of users on your team.';

async function findSlackUserByName(ctx: ClassicCtx, username: string): Promise<any | null> {
  const mention = /(^.*<@U.*)/g;
  if (username.match(mention)) {
    const uid = username.replace('@', '').replace('<', '').replace('>', '');
    const res = await ctx.api<{ user?: any }>(ctx.install.botToken, 'users.info', { user: uid });
    return res.user ?? null;
  }
  const res = await ctx.api<{ members?: any[] }>(ctx.install.botToken, 'users.list', {});
  for (const member of res.members ?? []) {
    if (
      (member.id && member.id.indexOf(username) > -1) ||
      (member.name && member.name.indexOf(username) > -1) ||
      (member.real_name && member.real_name.indexOf(username) > -1)
    ) {
      return member;
    }
  }
  return null;
}

/** sendInviteMessage/sendInviteMessageToTeamMember (identical bodies) —
 *  conversations.open the target's DM + post the invite + bot list. */
export async function inviteMemberToIm(
  ctx: ClassicCtx,
  username: string,
  inviterUserId: string,
  botObjs: { name: string; client_key: string }[],
): Promise<{ name: string } | null> {
  const user = await findSlackUserByName(ctx, username);
  if (!user) return null;
  const opened = await ctx.api<{ channel?: { id?: string } }>(ctx.install.botToken, 'conversations.open', {
    users: user.id,
  });
  const dmChannel = opened.channel?.id;
  if (!dmChannel) return null;
  const reply: any = { text: INVITE_TEXT(user.id, inviterUserId), attachments: [] };
  if (botObjs.length > 1) {
    reply.text += ' Below is a list of bots that have been added by someone on your team. Select one to get started:';
  } else if (botObjs.length === 1) {
    reply.text += ' Here is the bot that has been added by someone on your team. Click it to get started:';
  } else {
    reply.attachments.push({
      text: '',
      callback_id: 'welcome_buttons',
      attachment_type: 'default',
      actions: [
        { name: 'Add a Bot', text: 'Add a Bot', type: 'button', value: 'Add a Bot' },
        { name: 'help', text: 'Help', type: 'button', value: 'Help' },
      ],
    });
  }
  if (botObjs.length > 1) {
    reply.attachments.push({
      mrkdwn_in: ['fields', 'text', 'pretext'],
      text: '',
      fallback: 'bot selection list',
      color: '#3AA3E3',
      attachment_type: 'default',
      callback_id: 'set_bot_get_keys',
      actions: [
        {
          name: 'set_bot',
          text: 'Select your bot...',
          type: 'select',
          options: botObjs.map((b) => ({ text: b.name, value: b.name })),
        },
      ],
    });
  } else if (botObjs.length === 1) {
    reply.attachments.push({
      text: '',
      callback_id: 'set_bot_get_keys',
      attachment_type: 'default',
      actions: [{ name: botObjs[0].name, text: botObjs[0].name, type: 'button', value: botObjs[0].name }],
    });
  }
  await ctx.api(ctx.install.botToken, 'chat.postMessage', { channel: dmChannel, ...reply });
  return { name: user.name ?? user.real_name ?? username };
}

// ── manageIntents (training.js 2866-3152) ──────────────────────────────────

/** Creates or revives the `ai-<botname>` training channel, posts the welcome
 *  message, invites the member, returns the channel {id, name}. */
export async function manageIntents(
  ctx: ClassicCtx,
  message: { channel: string; user?: string },
  options: { client_key?: string; lang?: string; bot_name?: string },
  botName: string,
): Promise<{ id: string; name: string } | null> {
  let channelName = `ai-${botName}`;
  channelName = channelName.replace(' ', '-');
  channelName = channelName.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '-').toLowerCase();

  // getManageChannelByClientKey: existing training channel for this client_key
  const [existing] = await ctx.db
    .select()
    .from(slackClassicChannels)
    .where(
      and(
        eq(slackClassicChannels.installationId, ctx.install.id),
        eq(slackClassicChannels.clientKey, options.client_key ?? ''),
        eq(slackClassicChannels.isTrainingChannel, true),
      ),
    )
    .limit(1);

  const botUserId = (ctx.install.classicConfig as { botUserId?: string })?.botUserId;

  const saveChannel = async (ch: { id: string; name: string }) => {
    const { saveClassicChannel } = await import('./store.js');
    await saveClassicChannel(ctx.db, {
      installationId: ctx.install.id,
      sourceChannel: `training:${options.client_key ?? ''}`,
      slackChannelId: ch.id,
      name: ch.name,
      clientKey: options.client_key ?? null,
      lang: options.lang ?? null,
      isWordhopChannel: false,
      isTrainingChannel: true,
      trainingEnabled: true,
    });
  };

  const createChannel = async (label: string, index: number): Promise<{ id: string; name: string } | null> => {
    const res = await ctx.api<{ channel?: { id: string; name: string } }>(ctx.install.botToken, 'conversations.create', {
      name: label,
    });
    if (!res.ok || !res.channel) {
      if (res.error === 'name_taken') {
        const suffix = `-${index}`;
        const remainder = 21 - suffix.length;
        return createChannel(`${channelName.substr(0, remainder)}${suffix}`, index + 1);
      }
      return null;
    }
    const ch = res.channel;
    await saveChannel(ch);
    if (botUserId) {
      await ctx.api(ctx.install.botToken, 'conversations.invite', { channel: ch.id, users: botUserId });
      await ctx.api(ctx.install.botToken, 'conversations.leave', { channel: ch.id });
    }
    return ch;
  };

  let channel: { id: string; name: string } | null = null;
  if (existing) {
    const info = await ctx.api<{ channel?: { is_archived?: boolean } }>(ctx.install.botToken, 'conversations.info', {
      channel: existing.slackChannelId,
    });
    if (!info.ok || info.error === 'channel_not_found') {
      channel = await createChannel(channelName, 1);
    } else {
      await saveChannel({ id: existing.slackChannelId, name: existing.name });
      if (info.channel?.is_archived) {
        await ctx.api(ctx.install.botToken, 'conversations.unarchive', { channel: existing.slackChannelId });
      }
      channel = { id: existing.slackChannelId, name: existing.name };
    }
  } else {
    channel = await createChannel(channelName, 1);
  }
  if (!channel) return null;

  // bot invite already happened on create; verbatim also invites on every
  // manageIntents call (already_in_channel errors are ignored).
  if (botUserId) {
    await ctx.api(ctx.install.botToken, 'conversations.invite', { channel: channel.id, users: botUserId });
  }
  await ctx.say({
    channel: channel.id,
    text:
      'Welcome to bot training! Invite others to this channel so you can collaborate on training and accelerate your messaging automation.' +
      'Note that my capabilities in this channel are limited to training. DM me for all other questions.',
    attachments: [
      {
        title: 'How to use this channel',
        text: 'Chat and get responses from your bot.  View my replies to train your bot.',
        mrkdwn_in: ['fields'],
        fields: [
          {
            short: false,
            value: ':speech_balloon: *Chat with me:* Send messages and get replies from your bot.',
          },
          {
            short: false,
            value:
              ':eyes: *See my replies:* I\'ll reply after every message. Click to categorize what users say and add responses for each message.',
          },
          {
            short: false,
            value:
              ':robot_face: *Test:* After you train, send me the same message again and see your bot respond. Be patient if you don\'t ' +
              'get the response you were hoping for right away. It takes a few seconds for AI to learn.',
          },
        ],
        id: 1,
      },
    ],
  });
  if (message.user) {
    const inv = await ctx.api(ctx.install.botToken, 'conversations.invite', {
      channel: channel.id,
      users: message.user,
    });
    if (!inv.ok && inv.error !== 'already_in_channel') {
      await ctx.api(ctx.install.botToken, 'conversations.join', { channel: channel.id });
    }
  }
  ctx.result.posted.push({ channel: channel.id, ts: '', kind: 'manageIntents' });
  return channel;
}

// ── addManyChatToken / editBotModal (slack_bot.js 3522-3790) ───────────────
// Both open the `modify_bot:<client_key>` dialog; editBotModal's DF-agent
// select stays empty without the member's Google OAuth link (verbatim
// degradation — legacy's searchAgents yields no options).

function matchingBotFor(
  channel: { clientKey?: string | null; isWordhopChannel?: boolean } | null,
  doc: { bot_context?: { client_key?: string }; bot_name?: string },
  botObjs: { name: string; client_key: string }[],
): { name: string; client_key: string } | null {
  if (doc.bot_context?.client_key) {
    const m = botObjs.filter((o) => o.client_key === doc.bot_context!.client_key);
    if (m[0]) return m[0];
  } else if (channel?.clientKey && channel.isWordhopChannel) {
    const m = botObjs.filter((o) => o.client_key === channel.clientKey);
    if (m[0]) return m[0];
  } else if (doc.bot_name) {
    const m = botObjs.filter((o) => o.name === doc.bot_name);
    if (m[0]) return m[0];
  } else if (botObjs.length > 0) {
    return botObjs[0];
  }
  return null;
}

const textTruncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function addManyChatTokenDialog(
  ctx: ClassicCtx,
  channel: { clientKey?: string | null; isWordhopChannel?: boolean } | null,
  doc: { bot_context?: { client_key?: string }; bot_name?: string },
  triggerId: string,
): Promise<boolean> {
  const botObjs = await botObjsForWorkspace(ctx);
  const matchingBot = matchingBotFor(channel, doc, botObjs);
  if (!matchingBot) return false;
  const meta = await agentMetaFor(ctx, matchingBot.client_key);
  let token: string | undefined;
  if (meta.code_lang === 'manychat' && meta.manychat_token) token = String(meta.manychat_token).trim();
  else if (meta.code_lang === 'chatfuel' && meta.chatfuel_token) token = String(meta.chatfuel_token).trim();
  const optional = meta.code_lang !== 'manychat';
  const dialog: any = {
    callback_id: `modify_bot:${matchingBot.client_key}`,
    title: textTruncate(matchingBot.name, 24),
    submit_label: 'Save',
    notify_on_cancel: false,
    elements: [
      {
        label: 'Manychat API Token',
        name: 'token',
        type: 'text',
        value: token,
        placeholder: 'Paste your API Token here',
        optional,
        hint: 'Chatfuel or Manychat API token',
      },
    ],
  };
  if (meta.code_lang === 'chatfuel') {
    dialog.elements[0].label = 'Chatfuel API Token';
    dialog.elements.push({
      label: 'Chatfuel Bot ID',
      name: 'chatfuel_botid',
      type: 'text',
      value: meta.chatfuel_botid,
      placeholder: 'Paste your Chatfuel Bot ID here',
      optional: true,
    });
  }
  const res = await openClassicDialog(ctx, {
    triggerId,
    dialog,
    channel: '',
  });
  ctx.result.posted.push({ channel: '', ts: '', kind: 'dialog:modify_bot' });
  return res;
}

export async function editBotModalDialog(
  ctx: ClassicCtx,
  channel: { clientKey?: string | null; isWordhopChannel?: boolean } | null,
  doc: { bot_context?: { client_key?: string }; bot_name?: string },
  triggerId: string,
): Promise<boolean> {
  const botObjs = await botObjsForWorkspace(ctx);
  const matchingBot = matchingBotFor(channel, doc, botObjs);
  if (!matchingBot) return false;
  const meta = await agentMetaFor(ctx, matchingBot.client_key);
  let codeLang = meta.code_lang ? String(meta.code_lang).replace(/^\w/, (c) => c.toUpperCase()) : null;
  if (codeLang === 'Dialogflow') codeLang = 'Only Dialogflow';
  if (codeLang === 'Npm') codeLang = 'Node.js';
  let token: string | undefined;
  if (meta.code_lang === 'manychat' && meta.manychat_token) token = String(meta.manychat_token).trim();
  else if (meta.code_lang === 'chatfuel' && meta.chatfuel_token) token = String(meta.chatfuel_token).trim();
  const optional = meta.code_lang !== 'manychat';
  const dialog = {
    callback_id: `modify_bot:${matchingBot.client_key}`,
    title: 'Edit Bot',
    submit_label: 'Save',
    notify_on_cancel: false,
    elements: [
      {
        label: 'Bot name',
        name: 'bot_name',
        type: 'text',
        value: matchingBot.name,
        placeholder: 'Type the name of your bot',
      },
      {
        label: 'Bot builder / framework',
        type: 'select',
        name: 'code_lang',
        value: codeLang,
        placeholder: 'What did you use to build your bot?',
        options: [
          { label: 'Chatfuel', value: 'Chatfuel' },
          { label: 'Manychat', value: 'Manychat' },
          { label: 'Node.js', value: 'Node.js' },
          { label: 'Python', value: 'Python' },
          { label: 'Ruby', value: 'Ruby' },
          { label: 'Only Dialogflow', value: 'Only Dialogflow' },
          { label: 'Botcopy', value: 'Botcopy' },
        ],
      },
      {
        label: 'Bot builder API Token',
        name: 'token',
        type: 'text',
        value: token,
        placeholder: 'Paste your API Token here',
        optional,
        hint: 'Chatfuel or Manychat API token',
      },
    ],
  };
  const res = await openClassicDialog(ctx, {
    triggerId,
    dialog,
    channel: '',
  });
  ctx.result.posted.push({ channel: '', ts: '', kind: 'dialog:edit_bot' });
  return res;
}

async function agentMetaFor(ctx: ClassicCtx, clientKey: string): Promise<Record<string, unknown>> {
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(sql`${agents.metadata}->>'legacy_client_key' = ${clientKey}`)
    .limit(1);
  return (agent?.metadata ?? {}) as Record<string, unknown>;
}

// ── sendIntentForTranscriptBot (slack_bot.js 9422-9486) ────────────────────

export async function sendIntentForTranscriptBot(
  ctx: ClassicCtx,
  message: { channel: string; isTranscriptChannel?: boolean },
  channel: { clientKey?: string | null; lang?: string | null; name?: string },
  text: string | null,
  event: { name: string; data?: any } | null,
  matchingBotMeta?: Record<string, unknown>,
): Promise<any> {
  const myContexts: { name: string; lifespan: number }[] = [];
  const options: any = { client_key: channel.clientKey, suggestionMode: true };
  if (event) options.event = event;
  else options.userSays = text;
  const mb = matchingBotMeta ?? {};
  if (mb.is_chatfuel) {
    options.is_chatfuel = mb.is_chatfuel;
    myContexts.push({ name: 'is_chatfuel', lifespan: 1 });
  } else if (mb.is_manychat) {
    options.is_manychat = mb.is_manychat;
    myContexts.push({ name: 'is_manychat', lifespan: 1 });
  }
  options.contexts = myContexts;
  message.isTranscriptChannel = true;

  const { resolveTranscriptBot } = await import('./relay.js');
  const tb = await resolveTranscriptBot(ctx);
  if (!tb) {
    ctx.result.suppressed.push({ channel: message.channel, reason: 'sendIntentForTranscriptBot: no meta-bot creds' });
    return null;
  }
  options.lang = tb.lang ?? channel.lang;
  const body = await detectIntentV1(
    tb.sa.project_id,
    message.channel,
    {
      ...(options.userSays != null ? { text: options.userSays } : {}),
      ...(options.event ? { event: options.event } : {}),
      contexts: options.contexts,
      lang: options.lang,
    } as any,
    tb.sa,
  );
  const data: any = makeMessageFromApiAi(body, false);
  if (channel.name && data) {
    data.username = channel.name;
    data.icon_emoji = ':robot_face:';
  }
  if ((data.text != null && data.text !== '') || (data.attachments ?? []).length > 0) {
    await ctx.say({ ...data, channel: message.channel });
  }
  return body;
}
