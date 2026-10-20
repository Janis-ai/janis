// training.ts — the DF training-menu renderer ported verbatim from
// wordhop-slack/src/training.js: writeTrainAttachments (1946-2493),
// getActionsMenu (2495-2861), makeApiAiUserSaysAttachment (939-1092),
// makeApiAiResponseAttachment (305-937), plus the message scanners
// (getIntentIdFromMessage / getTsFromMessage / counts).
//
// The menu this produces is attached to every transcript 'in' line for
// DF-enabled bots — the "did the bot get it right?" surface.

import { removeFormatting } from './profiles.js';

const PAGING_LIMIT = 5;

const isJson = (str: unknown): boolean => {
  try {
    if (typeof str === 'string') JSON.parse(str);
    else return false;
  } catch {
    return false;
  }
  return true;
};

const FOLLOWUP_TYPES = ['custom', 'fallback', 'yes', 'no', 'later', 'cancel', 'more', 'next', 'previous', 'repeat'];
const followUpTypeOptions = FOLLOWUP_TYPES.map((t) => ({ text: t, value: t }));

const isEven = (n: number) => n % 2 === 0;

export interface TrainOptions {
  client_key?: string;
  editMode?: boolean;
  userSays?: string;
  ts?: number;
  raw?: string;
  is_training_channel?: boolean;
  is_chatfuel?: boolean;
  is_manychat?: boolean;
  followup?: string;
  followupId?: string;
  reply_type?: string;
  user_says_type?: string;
  responses_page?: number | string;
  userssay_page?: number | string;
  lang?: string;
  response?: any;
}

export interface TrainIntent {
  id: string;
  name?: string;
  userSays?: { data: { text: string }[] }[];
  responses?: { messages?: any[] }[];
  followUpIntentsArr?: { name?: string; id: string }[];
  fallbackIntent?: boolean;
  parentIntentName?: string;
  parentId?: string;
  from_menu?: boolean;
}

// findApiAiResponseAndWriteAttachment (training.js 1684-1783) — per-message
// enrichment: resolve the intent behind the stored DF reply and attach the
// training menu (`message.menu`). `findIntent` is injected by the caller —
// it resolves intent docs on the customer agent's DF project via getIntentV1.
export async function findApiAiResponseAndWriteAttachment(
  message: any,
  options: TrainOptions,
  findIntent: (intentId: string) => Promise<TrainIntent | null>,
): Promise<any> {
  let input = message.text;
  if (input == null && message.attachments?.length > 0) {
    for (const attachment of message.attachments) {
      if (attachment.type === 'image' && attachment.payload) {
        input = attachment.payload.url;
      }
    }
  }
  options.userSays = input;
  if (message.ts) options.ts = message.ts;

  let intent: TrainIntent | { id: 'new' } | any = { id: 'new' };
  let storedIntent: TrainIntent | null = null;

  if (message.reply) {
    let response = message.reply;
    if (typeof response === 'string') {
      try {
        response = JSON.parse(response);
      } catch {
        response = null;
      }
    }
    const result = response?.result;
    if (result?.error && result.error.message === 'Input text exceeds 256 bytes.') {
      return message;
    }
    intent = message.intent;
    const lang = response?.lang;
    if (lang) options.lang = lang;
    options.response = response;

    if (!(result?.fulfillment && intent)) {
      if (result?.metadata?.intentId) {
        storedIntent = await findIntent(result.metadata.intentId);
      } else {
        intent = { id: 'new' };
      }
    }
    if (typeof intent === 'string' && isJson(intent)) {
      intent = JSON.parse(intent);
    }
  }

  const resolved = storedIntent ?? intent ?? { id: 'new' };
  try {
    const menu = writeTrainAttachments(resolved, options);
    message.menu = menu.attachments;
  } catch {
    // legacy swallows errors here (the .catch in the promise chain logs and
    // continues) — a line that can't render a menu still posts.
  }
  return message;
}

// ── message scanners ───────────────────────────────────────────────────────

export function getIntentIdFromMessage(message: any): string {
  let intentId = 'new';
  if (message?.attachments) {
    for (let i = message.attachments.length - 1; i >= 0; i--) {
      const attachment = message.attachments[i];
      if (attachment.callback_id === 'reply_type' && attachment.actions) {
        intentId = attachment.actions[0].name;
        break;
      }
    }
  }
  return intentId;
}

export function getTsFromMessage(message: any): number | null {
  let ts: number | undefined;
  if (message?.attachments) {
    for (let i = message.attachments.length - 1; i >= 0; i--) {
      const attachment = message.attachments[i];
      if (attachment.callback_id === 'reply_type' && attachment.actions) {
        const action = attachment.actions[0];
        for (const option of action.options ?? []) {
          if (String(option.value).substring(0, 4) === 'raw:') {
            ts = parseFloat(String(option.value).substring(4));
            break;
          }
        }
      }
    }
  }
  return ts ?? null;
}

export function getNumberOfResponsesFromMessage(message: any): number {
  let count = 0;
  for (const attachment of message?.attachments ?? []) {
    if (attachment.fields?.[0]?.value?.substring(0, 29) === '*:robot_face: Your responses') {
      count = parseInt(attachment.fields[0].value.match(/\d+/)[0], 10);
      break;
    }
  }
  return count;
}

export function getNumberOfUserSaysFromMessage(message: any): number {
  let count = 0;
  for (const attachment of message?.attachments ?? []) {
    if (attachment.fields?.[0]?.value?.substring(0, 32) === '*:speech_balloon: What users say') {
      count = parseInt(attachment.fields[0].value.match(/\d+/)[0], 10);
      break;
    }
  }
  return count;
}

// ── makeApiAiUserSaysAttachment (training.js 939-1092) ─────────────────────

export function makeApiAiUserSaysAttachment(attachments: any[], intent: TrainIntent, options: TrainOptions): any[] {
  const userSaysArr: any[] = [];

  if (intent.userSays && intent.userSays.length > 0) {
    attachments.push({
      mrkdwn_in: ['fields', 'text', 'pretext'],
      fallback: `What users say (${intent.userSays.length})`,
      color: '#bd48b2',
      fields: [{ short: false, value: `*:speech_balloon: What users say (${intent.userSays.length})*` }],
    });
  }
  let color = '#bd48b2';
  const page = options.userssay_page ? parseInt(String(options.userssay_page), 10) : 0;
  const arr = intent.userSays ? [...intent.userSays].reverse() : [];
  void userSaysArr;
  const pos = (page + 1) * PAGING_LIMIT - PAGING_LIMIT;
  const length = Math.min(arr.length, pos + PAGING_LIMIT);
  for (let i = pos; i < length; i++) {
    let text = '';
    for (const d of arr[i].data) text += d.text;
    const attachment: any = {
      mrkdwn_in: ['fields', 'text', 'pretext'],
      fallback: text,
      fields: [{ short: false, value: text }],
      callback_id: 'intent_user_says',
      color,
      attachment_type: 'default',
    };
    color = '#bd48b2';
    if (isEven(i)) color = '#bd48b2';
    if (options.editMode) {
      attachment.actions = [
        {
          name: 'delete',
          text: 'X',
          type: 'button',
          value: 'delete',
          style: 'danger',
          confirm: {
            title: 'Delete',
            text: 'Permanently delete this from what users might say?',
            ok_text: 'Yes',
            dismiss_text: 'Cancel',
          },
        },
      ];
    }
    attachments.push(attachment);
  }

  const lastPage = Math.ceil(arr.length / PAGING_LIMIT);
  if (lastPage > 1) {
    const pageOptions = [];
    for (let i = 0; i < lastPage; i++) {
      pageOptions.push({ text: `Page ${i + 1} of ${lastPage}`, value: i });
    }
    attachments.push({
      mrkdwn_in: ['fields', 'text', 'pretext'],
      fallback: `Page: ${page + 1}`,
      fields: [{ short: false, value: '' }],
      callback_id: 'userssay_page',
      color,
      attachment_type: 'default',
      selected_options: [{ text: `Page ${page} of ${lastPage}`, value: page - 1 }],
      actions: [
        {
          name: 'responses_page_label',
          text: `Page ${page + 1} of ${lastPage}`,
          type: 'select',
          options: pageOptions,
        },
      ],
    });
  }
  return attachments;
}

// ── makeApiAiResponseAttachment (training.js 305-937) ──────────────────────

export function makeApiAiResponseAttachment(attachments: any[], messages: any[] | null, options: TrainOptions): any[] {
  if (messages == null) return attachments;

  let speech: string | string[] | undefined;
  const quickReplies: any[] = [];
  const payloads: any[] = [];
  const chatfuels: any[] = [];
  const manychats: any[] = [];
  let quickRepliesCount = 0;

  for (const msg of messages) {
    if (msg.type === 0) {
      speech = msg.speech;
    } else if (msg.type === 2) {
      if (msg.replies) {
        quickReplies.push(msg);
        quickRepliesCount += msg.replies.length;
      }
    } else if (msg.type === 4 && msg.payload) {
      const keys = Object.keys(msg.payload);
      if (keys.length === 1 && keys[0] === 'redirect_to_blocks') {
        chatfuels.push(msg);
      } else if (keys.length === 1 && keys[0] === 'flow') {
        manychats.push(msg);
      } else {
        payloads.push(msg);
      }
    }
  }
  if (speech == null) speech = [];

  let responseCount = 0;
  if (typeof speech === 'string') {
    if (speech.trim().length > 0) responseCount = 1;
  } else if (speech.length > 0) {
    responseCount = speech.length;
  }

  const attachment: any = {
    mrkdwn_in: ['fields', 'text', 'pretext'],
    fallback: 'Your responses',
    color: '#53188d',
    fields: [{ short: false, value: '*:robot_face: Your responses*' }],
    attachment_type: 'default',
    callback_id: 'user_says_type',
    actions: [
      {
        selected_options: [],
        name: 'userSaysType',
        text: 'Select your response type...',
        type: 'select',
        options: [
          { text: `Text (${responseCount})`, value: 'text' },
          { text: `Quick reply (${quickRepliesCount})`, value: 'quickreplies' },
          { text: `Custom payload (${payloads.length})`, value: 'payloads' },
        ],
      },
    ],
  };
  const actionOptions = attachment.actions[0].options;
  if (options.is_chatfuel) {
    actionOptions.push({ text: `Chatfuel block (${chatfuels.length})`, value: 'chatfuelblock' });
  } else if (options.is_manychat) {
    actionOptions.push({ text: `Manychat flow (${manychats.length})`, value: 'manychatflow' });
  }
  let option = actionOptions[0];
  for (const o of actionOptions) {
    if (o.value === options.user_says_type) {
      option = o;
      break;
    }
  }
  if (options.user_says_type == null && responseCount === 0 && payloads.length > 0) {
    option = actionOptions[2];
    options.user_says_type = 'payloads';
  } else if (options.user_says_type == null && responseCount === 0 && chatfuels.length > 0) {
    option = actionOptions[3];
    options.user_says_type = 'chatfuelblock';
  } else if (options.user_says_type == null && responseCount === 0 && manychats.length > 0) {
    option = actionOptions[3];
    options.user_says_type = 'manychatflow';
  } else if (options.user_says_type == null && responseCount === 0 && quickRepliesCount > 0) {
    option = actionOptions[1];
    options.user_says_type = 'quickreplies';
  }
  attachment.actions[0].selected_options = [option];
  attachments.push(attachment);

  let color = '#53188d';
  if (options.user_says_type == null) options.user_says_type = 'text';

  const deleteAction = (confirmText: string) => [
    {
      name: 'delete',
      text: 'X',
      type: 'button',
      value: 'delete',
      style: 'danger',
      confirm: { title: 'Delete', text: confirmText, ok_text: 'Yes', dismiss_text: 'Cancel' },
    },
  ];
  const intentResponseAtt = () => ({
    mrkdwn_in: ['fields', 'text', 'pretext'],
    fallback: 'Response: ',
    fields: [{ short: false, value: '' }],
    callback_id: 'intent_response',
    color,
    attachment_type: 'default',
    actions: [] as any[],
  });

  if (options.user_says_type === 'payloads') {
    for (const p of payloads) {
      const attachment = intentResponseAtt();
      attachment.fallback = 'payload';
      attachment.fields[0].value = '```' + JSON.stringify(p.payload, null, 2) + '```';
      if (options.editMode) attachment.actions = deleteAction('Permanently delete this payload?');
      attachments.push(attachment);
    }
  } else if (options.user_says_type === 'chatfuelblock') {
    for (const c of chatfuels) {
      const attachment = intentResponseAtt();
      attachment.fallback = 'payload';
      attachment.fields[0].value = '```' + JSON.stringify(c.payload.redirect_to_blocks, null, 2) + '```';
      if (options.editMode) attachment.actions = deleteAction('Permanently delete this chatfuel redirect?');
      attachments.push(attachment);
    }
  } else if (options.user_says_type === 'manychatflow') {
    for (const m of manychats) {
      const attachment = intentResponseAtt();
      attachment.fallback = 'payload';
      attachment.fields[0].value = '```' + JSON.stringify(m.payload.flow, null, 2) + '```';
      if (options.editMode) attachment.actions = deleteAction('Permanently delete this manychat flow redirect?');
      attachments.push(attachment);
    }
  } else if (options.user_says_type === 'text') {
    if (typeof speech === 'string') {
      const attachment = intentResponseAtt();
      if (options.editMode) attachment.actions = deleteAction('Permanently delete this response?');
      attachment.fallback = `Response: ${speech}`;
      attachment.fields[0].value = speech;
      attachments.push(attachment);
    } else {
      const page = options.responses_page ? parseInt(String(options.responses_page), 10) : 0;
      const arr = [...speech].reverse();
      const pos = (page + 1) * PAGING_LIMIT - PAGING_LIMIT;
      const length = Math.min(arr.length, pos + PAGING_LIMIT);
      for (let i = pos; i < length; i++) {
        const attachment = intentResponseAtt();
        color = '#53188d';
        if (isEven(i)) color = '#53188d';
        if (options.editMode) attachment.actions = deleteAction('Permanently delete this response?');
        attachment.fallback = `Response ${i + 1}: ${arr[i]}`;
        attachment.fields[0].value = arr[i];
        attachments.push(attachment);
      }
      const lastPage = Math.ceil(arr.length / PAGING_LIMIT);
      if (lastPage > 1) {
        const pageOptions = [];
        for (let i = 0; i < lastPage; i++) {
          pageOptions.push({ text: `Page ${i + 1} of ${lastPage}`, value: i });
        }
        attachments.push({
          mrkdwn_in: ['fields', 'text', 'pretext'],
          fallback: `Page: ${page + 1}`,
          fields: [{ short: false, value: '' }],
          callback_id: 'responses_page',
          color,
          attachment_type: 'default',
          selected_options: [{ text: `Page ${page} of ${lastPage}`, value: page - 1 }],
          actions: [
            {
              name: 'responses_page_label',
              text: `Page ${page + 1} of ${lastPage}`,
              type: 'select',
              options: pageOptions,
            },
          ],
        });
      }
    }
  } else if (options.user_says_type === 'quickreplies') {
    const quickRepliesAttachment: any = {
      mrkdwn_in: ['fields', 'text', 'pretext'],
      text: '',
      callback_id: 'quick_reply_callback',
      attachment_type: 'default',
      fallback: '',
      color: '#53188d',
      actions: [],
    };
    if (options.editMode) {
      quickRepliesAttachment.actions.push({
        name: 'quick_replies',
        text: 'Select your quick reply...',
        type: 'select',
        selected_options: [],
        options: [],
      });
      quickRepliesAttachment.callback_id = 'quick_reply_menu_callback';
    }
    for (const response of quickReplies) {
      for (let r = 0; r < response.replies.length; r++) {
        const reply = response.replies[r];
        if (options.editMode) {
          const option = { text: reply, value: reply };
          quickRepliesAttachment.actions[0].options.push(option);
          if (r === 0) quickRepliesAttachment.actions[0].selected_options = [option];
        } else {
          quickRepliesAttachment.actions.push({ name: reply, text: reply, type: 'button', value: reply });
        }
      }
    }
    if (quickRepliesAttachment.actions.length > 0) {
      if (options.editMode) {
        if (quickRepliesAttachment.actions[0].options.length > 0) {
          quickRepliesAttachment.actions.push(...deleteAction('Permanently delete this quick reply?'));
          attachments.push(quickRepliesAttachment);
        }
      } else {
        attachments.push(quickRepliesAttachment);
      }
    }
  }
  return attachments;
}

// ── getActionsMenu (training.js 2495-2861) ─────────────────────────────────

export function getActionsMenu(
  actionType: string | undefined,
  options: TrainOptions,
  message: any,
  responseInstructionsAttachment: any,
): { attachment: any; actionOptions: any[]; selected_option: any } {
  const responsePage = options.responses_page ? parseInt(String(options.responses_page), 10) : 0;
  const responseCount = getNumberOfResponsesFromMessage(message);
  void Math.ceil(responseCount / PAGING_LIMIT); // lastResponsePage — legacy computes, never reads
  const userssayPage = options.userssay_page ? parseInt(String(options.userssay_page), 10) : 0;
  const userssayCount = getNumberOfUserSaysFromMessage(message);
  void Math.ceil(userssayCount / PAGING_LIMIT); // lastUserssayPage — same

  const actionOptions: any[] = [
    { text: 'Add a text response', value: 'responses' },
    { text: 'Add a quick reply (max 5)', value: 'quickreply' },
    { text: 'Add a custom payload', value: 'payload' },
    { text: 'Add what users say', value: 'userssay' },
    { text: 'Add follow-up intent', value: 'followup' },
    { text: 'Edit / Delete', value: 'edit' },
    { text: 'Manage other intents', value: 'manage_intents' },
  ];
  if (options.is_chatfuel) {
    actionOptions.splice(3, 0, { text: 'Add a Chatfuel redirect', value: 'chatfuel' });
  }
  if (options.is_manychat) {
    actionOptions.splice(3, 0, { text: 'Add a Manychat flow redirect', value: 'manychat' });
  }
  if (options.ts) {
    actionOptions.push({ text: 'See raw API response', value: `raw:${options.ts}` });
  }

  let attachment: any;
  let option = actionOptions[0];
  for (const o of actionOptions) {
    if (o.value === actionType) {
      option = o;
      break;
    }
  }

  const hint = (text: string, fallback = text) => ({
    mrkdwn_in: ['fields', 'text', 'pretext'],
    text,
    fallback,
    color: '#00cc66',
  });

  if (actionType === 'followup') {
    attachment = {
      mrkdwn_in: ['fields', 'text', 'pretext'],
      color: '#00cc66',
      callback_id: 'add_followup',
      fallback: '',
      fields: [{ short: false, value: '' }],
      actions: [
        {
          name: 'addFollowUp',
          text: 'When users say:',
          type: 'select',
          options: followUpTypeOptions,
          confirm: {
            title: 'Add follow-up intent',
            text:
              'Conversations can flow naturally, like human dialog. When you add a follow-up intent, ' +
              'a new intent will be created that incorporates the parent intent for context.',
            ok_text: 'Yes',
            dismiss_text: 'Cancel',
          },
        },
      ],
    };
  } else if (actionType === 'userssay') {
    attachment = hint('_Reply to add what users say_', 'Reply to add what users say');
  } else if (actionType === 'quickreply') {
    attachment = hint(
      '_Reply to add a label for a quick reply button._',
      'Reply to add a label for a quick reply button',
    );
  } else if (actionType === 'payload') {
    attachment = hint(
      '_Reply with your payload. Use Shift+Return to add separate lines._',
      'Reply with your payload. Use Shift+Return to add separate lines.',
    );
  } else if (actionType === 'chatfuel') {
    attachment = hint(
      '_Reply with a Chatfuel block name. For multiple blocks, separate with commas._',
      'Reply with a Chatfuel block name. For multiple blocks, separate with commas.',
    );
  } else if (actionType === 'manychat') {
    attachment = hint('_Reply with a Manychat flow ID._', 'Reply with a Manychat flow ID.');
  } else if (actionType === 'responses_page_display') {
    const page = responsePage;
    const count = responseCount;
    const lastPage = Math.ceil(count / PAGING_LIMIT);
    const pageOptions = [];
    for (let i = 0; i < lastPage; i++) {
      pageOptions.push({ text: `Page ${i + 1} of ${lastPage}`, value: i });
    }
    if (lastPage > 1) {
      attachment = {
        mrkdwn_in: ['fields', 'text', 'pretext'],
        fallback: `Page: ${page + 1}`,
        fields: [{ short: false, value: '' }],
        callback_id: 'responses_page',
        color: '#53188d',
        attachment_type: 'default',
        selected_options: [{ text: `Page ${page} of ${lastPage}`, value: page - 1 }],
        actions: [
          {
            name: 'responses_page_label',
            text: `Page ${page + 1} of ${lastPage}`,
            type: 'select',
            options: pageOptions,
          },
        ],
      };
    }
  } else if (actionType === 'userssay_page_display') {
    const page = userssayPage;
    const count = userssayCount;
    const lastPage = Math.ceil(count / PAGING_LIMIT);
    const pageOptions = [];
    for (let i = 0; i < lastPage; i++) {
      pageOptions.push({ text: `Page ${i + 1} of ${lastPage}`, value: i });
    }
    if (lastPage > 1) {
      attachment = {
        mrkdwn_in: ['fields', 'text', 'pretext'],
        fallback: `Page: ${page + 1}`,
        fields: [{ short: false, value: '' }],
        callback_id: 'userssay_page',
        color: '#53188d',
        attachment_type: 'default',
        selected_options: [{ text: `Page ${page} of ${lastPage}`, value: page - 1 }],
        actions: [
          {
            name: 'userssay_page_label',
            text: `Page ${page + 1} of ${lastPage}`,
            type: 'select',
            options: pageOptions,
          },
        ],
      };
    }
  } else if (actionType === 'edit') {
    attachment = hint('_Make changes then click Done Editing_', 'Make changes then click Done Editing');
  } else if (actionType === 'suggested_response') {
    attachment = hint('_Send a saved response to the user_', 'Send a saved response to the user');
  } else if (actionType === 'createnew') {
    attachment = hint(
      '_Reply with a new intent name. The message above will be added to the intent._',
      'Reply with a new intent name. The message above will be added to the intent.',
    );
  } else {
    attachment = hint('_Reply with a text response._', 'Reply with a text response.');
  }

  if (options.editMode && responseInstructionsAttachment.actions) {
    const last = responseInstructionsAttachment.actions[responseInstructionsAttachment.actions.length - 1];
    if (last?.value !== 'done' && last?.name !== 'done') {
      responseInstructionsAttachment.actions.push({
        name: 'done',
        text: 'Done Editing',
        type: 'button',
        style: 'primary',
        value: 'done',
      });
    }
  }
  return { attachment, actionOptions, selected_option: option };
}

// ── writeTrainAttachments (training.js 1946-2493) ──────────────────────────

export function writeTrainAttachments(intent: TrainIntent, options: TrainOptions): { text: string; response_type: string; attachments: any[] } {
  if (intent == null) throw new Error('no intent');
  if (intent.id == null) throw new Error('intent has no id');
  if (intent.id === 'new') {
    intent.name = '';
    intent.userSays = [];
    options.editMode = false;
  }

  const client_key = options.client_key ?? '';

  const menu: any = {
    text: '',
    response_type: 'in_channel',
    attachments: [
      {
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: '',
        title: '',
        fallback: 'Train your bot',
        color: '#c4c4c4',
        attachment_type: 'default',
        callback_id: 'intent_selection',
        actions: [],
      },
    ],
  };

  const categorySelectionAttachment: any = {
    mrkdwn_in: ['fields', 'text', 'pretext'],
    text: '',
    title: '',
    fallback: 'Search Intents...',
    color: '#c4c4c4',
    attachment_type: 'default',
    callback_id: 'intent_selection',
    actions: [
      {
        name: 'manage_intent_list',
        text: 'Search Intents...',
        type: 'select',
        data_source: 'external',
      },
    ],
  };

  if (options.editMode) {
    menu.attachments[0].actions = [
      {
        name: 'delete',
        text: 'Delete Intent',
        type: 'button',
        value: intent.id,
        style: 'danger',
        confirm: {
          title: 'Delete',
          text: 'Permanently delete this intent and all data associated with it?',
          ok_text: 'Yes',
          dismiss_text: 'Cancel',
        },
      },
    ];
  }

  let isIntentFallBack = true;

  if (intent.id !== 'new' && intent) {
    let name = intent.name;
    if (name) name = name.replace(client_key + ' ', '');
    categorySelectionAttachment.actions[0].selected_options = [{ text: name, value: intent.id }];
    if (intent.fallbackIntent === false) isIntentFallBack = false;
  }

  let attachments = menu.attachments;

  if (intent.id === 'new' || intent == null) {
    isIntentFallBack = false;
  } else {
    if (intent.followUpIntentsArr) {
      const followupOptions: any[] = [];
      for (const followup of intent.followUpIntentsArr) {
        if (followup && followup.name) {
          const name = followup.name.replace(client_key + ' ', '');
          const names = name.split(' - ');
          const str = new Array(names.length).join('───');
          followupOptions.push({ text: `${str} ${names.pop()}`, value: followup.id, name });
        }
      }
      followupOptions.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      let parentName = intent.name ?? '';
      let parentid = intent.id;
      if (intent.parentIntentName) {
        parentName = intent.parentIntentName;
        parentid = intent.parentId ?? intent.id;
      }
      followupOptions.unshift({ text: parentName.replace(client_key + ' ', ''), value: parentid });
      menu.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: '',
        title: '',
        fallback: '',
        color: '#ff6600',
        attachment_type: 'default',
        callback_id: 'followup_list',
        actions: [
          {
            selected_options: [],
            name: 'followup_selection',
            text: 'follow-up intents',
            type: 'select',
            options: followupOptions,
          },
        ],
      });
    }

    if (!isIntentFallBack) {
      attachments = makeApiAiUserSaysAttachment(attachments, intent, options);
    }
    if (intent.responses?.[0]?.messages) {
      attachments = makeApiAiResponseAttachment(attachments, intent.responses[0].messages, options);
    }

    if (options.raw) {
      menu.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: '```' + JSON.stringify(JSON.parse(options.raw), null, 2) + '```',
        title: 'Raw API response',
        fallback: 'Raw API response',
        color: '#00cc66',
      });
    }

    if (options.is_training_channel == null) {
      menu.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: ' ',
        title: ' ',
        fallback: 'Send to user',
        color: '#00cc66',
        attachment_type: 'default',
        callback_id: 'send_to_user',
        actions: [
          {
            name: 'suggested',
            text: ':point_up: Send To User',
            type: 'button',
            value: 'suggested',
            style: 'primary',
          },
        ],
      });
    }

    const responseInstructionsAttachment: any = {
      mrkdwn_in: ['fields', 'text', 'pretext'],
      text: ':point_right: *What would you like to do?*',
      title: ' ',
      fallback: 'point_right: What would you like to do?',
      color: '#00cc66',
      attachment_type: 'default',
      callback_id: 'reply_type',
      actions: [
        {
          selected_options: [],
          name: intent.id,
          text: 'Select your reply method...',
          type: 'select',
        },
      ],
    };

    if (!isIntentFallBack && intent.userSays && intent.userSays.length === 0) {
      options.reply_type = 'userssay';
    }

    const actionMenuObject = getActionsMenu(options.reply_type, options, menu, responseInstructionsAttachment);
    responseInstructionsAttachment.actions[0].selected_options[0] = actionMenuObject.selected_option;
    responseInstructionsAttachment.actions[0].options = actionMenuObject.actionOptions;
    if (isIntentFallBack) {
      if (options.is_chatfuel || options.is_manychat) {
        responseInstructionsAttachment.actions[0].options.splice(4, 1);
      } else {
        responseInstructionsAttachment.actions[0].options.splice(3, 1);
      }
    }
    if (options.followup && options.followupId) {
      actionMenuObject.attachment.actions[0].selected_options = [{ text: options.followup, value: options.followup }];
    }
    menu.attachments.push(responseInstructionsAttachment);
    menu.attachments.push(actionMenuObject.attachment);

    if (options.followup && options.followupId && options.reply_type === 'followup') {
      menu.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: '',
        title: ' ',
        fallback: '',
        color: '#00cc66',
        attachment_type: 'default',
        callback_id: 'followup_nav',
        actions: [
          {
            name: 'followup_nav',
            text: 'Manage follow-up',
            type: 'button',
            value: options.followupId,
            style: 'default',
          },
        ],
      });
    }
  }

  const userSays = options.userSays;
  if (userSays) {
    let name = '';
    if (intent.name) name = intent.name.replace(client_key + ' ', '');
    let isTextInUserSays = false;
    const trainingModeMessage = menu.attachments[0];
    if (intent.userSays) {
      for (const us of intent.userSays) {
        let text = '';
        for (const d of us.data) text += d.text;
        if (String(removeFormatting(text)).toLowerCase().trim() === String(removeFormatting(userSays)).toLowerCase().trim()) {
          isTextInUserSays = true;
        }
      }
    }
    trainingModeMessage.text = name;

    if (intent.id === 'new') {
      const action: any = {
        name: 'createnew',
        text: 'Save as new intent',
        type: 'button',
        value: 'createnew',
        style: 'primary',
      };
      trainingModeMessage.actions.push(action);
      trainingModeMessage.callback_id = 'create_new';
      menu.attachments.splice(1, 0, categorySelectionAttachment);
      menu.text = '';
      trainingModeMessage.title = 'Categorize this message :point_up:';
      if (options.ts) action.name = `createnew:${options.ts}`;

      menu.attachments.splice(1, 0, {
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: ' ',
        title: ' ',
        fields: [
          { short: false, value: '*OR*' },
          { short: false, value: '_Detect an intent._' },
        ],
        fallback: '',
        color: '#c4c4c4',
        attachment_type: 'default',
        callback_id: 'detect_intent',
        actions: [{ name: 'detect', text: 'Find closest match', type: 'button', value: 'detect', style: 'primary' }],
      });

      categorySelectionAttachment.fields = [
        { short: false, value: '*OR*' },
        { short: false, value: '_Add this message to an existing intent._' },
      ];
      menu.attachments.push({
        text: '',
        title: '',
        mrkdwn_in: ['fields', 'text', 'pretext'],
        fallback: 'Reply with a new intent name. The message above will be added to the intent.',
        fields: [
          { short: false, value: '*OR*' },
          { short: false, value: '_Reply with a new intent name. The message above will be added to the intent._' },
        ],
      });
    } else if (isIntentFallBack) {
      trainingModeMessage.actions.push({
        name: 'find_other_intent',
        text: 'Change',
        type: 'button',
        value: intent.id,
        style: 'danger',
      });
      trainingModeMessage.title = 'Matched Intent:';
    } else if (!isTextInUserSays) {
      if (options.editMode !== true) {
        trainingModeMessage.actions.push({
          name: 'approve',
          text: 'Confirm Match',
          type: 'button',
          value: intent.id,
          style: 'primary',
        });
        trainingModeMessage.actions.push({
          name: 'find_other_intent',
          text: 'Other',
          type: 'button',
          value: intent.id,
          style: 'default',
        });
      }
      trainingModeMessage.title = 'Suggested Intent:';
    } else {
      const action = {
        name: 'reject',
        text: 'Cancel Match',
        type: 'button',
        value: intent.id,
        style: 'danger',
        confirm: {
          title: 'Cancel',
          text: 'Disconnect this message from the matched intent?',
          ok_text: 'Yes',
          dismiss_text: 'Cancel',
        },
      };
      if (options.editMode !== true) trainingModeMessage.actions.push(action);
      trainingModeMessage.title = 'Matched Intent:';
    }
    menu.attachments[0] = trainingModeMessage;
  } else {
    menu.text = ' ';
    menu.attachments[0].text = ' ';
    if (intent.id === 'new') {
      menu.attachments[0].actions.splice(0, 0, categorySelectionAttachment.actions[0]);
      menu.text = 'Manage other intents';
      menu.attachments.push({
        text: '',
        title: '',
        mrkdwn_in: ['fields', 'text', 'pretext'],
        fallback: 'Reply with a name for a new intent.',
        fields: [
          { short: false, value: '*OR*' },
          { short: false, value: '_Reply with a name for a new intent._' },
        ],
      });
      menu.attachments.push({
        mrkdwn_in: ['fields', 'text', 'pretext'],
        text: ' ',
        title: ' ',
        fields: [
          { short: false, value: '*OR*' },
          { short: false, value: '_Detect an intent._' },
        ],
        fallback: '',
        color: '#c4c4c4',
        attachment_type: 'default',
        callback_id: 'detect_intent',
        actions: [{ name: 'detect', text: 'Find closest match', type: 'button', value: 'detect', style: 'primary' }],
      });
    } else {
      const name = (intent.name ?? '').replace(client_key + ' ', '');
      menu.attachments[0].text = name;
      menu.attachments[0].title = 'Intent:';
      menu.attachments[0].color = '#c4c4c4';
    }
  }
  return menu;
}
