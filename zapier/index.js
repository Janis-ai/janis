const BASE = 'https://app.janis.ai';

// One Janis agent API key = one Zapier connection. The key is accepted via
// X-API-KEY (what Zapier's API-key auth sends natively); Bearer also works.
const authentication = {
  type: 'custom',
  test: { url: `${BASE}/v1/me` },
  connectionLabel: '{{bundle.inputData.name}}',
  fields: [
    {
      key: 'api_key',
      label: 'Agent API Key',
      type: 'password',
      required: true,
      helpText:
        "In the Janis console: open your agent → Connection tab → Credentials → Generate API key. Keys start with jk_live_.",
    },
  ],
};

const addApiKey = (request, z, bundle) => {
  request.headers['X-API-KEY'] = bundle.authData.api_key;
  return request;
};

const CONVERSATION_SAMPLE = {
  id: 'cc7073c9-05a1-4fc4-be2a-caff51ffbb91',
  external_id: 'email:customer@example.com',
  state: 'active',
  user_profile: { name: 'Jane Customer', email: 'customer@example.com', channel: 'email' },
  last_message_preview: 'Thanks — that answers my question.',
  last_message_at: '2026-01-01T12:00:00.000Z',
  created_at: '2026-01-01T11:55:00.000Z',
};

const CONVERSATION_FIELDS = [
  { key: 'id', label: 'Internal ID' },
  { key: 'external_id', label: 'External Conversation ID' },
  { key: 'state', label: 'State' },
  { key: 'user_profile__name', label: 'Customer Name' },
  { key: 'user_profile__email', label: 'Customer Email' },
  { key: 'user_profile__channel', label: 'Channel' },
  { key: 'last_message_preview', label: 'Last Message' },
  { key: 'last_message_at', label: 'Last Activity' },
  { key: 'created_at', label: 'Created' },
];

const pollConversations = (state) => async (z, bundle) => {
  const res = await z.request({
    url: `${BASE}/v1/conversations`,
    params: state ? { state } : {},
  });
  return res.data;
};

const conversationTrigger = (key, label, description, state) => ({
  key,
  noun: 'Conversation',
  display: { label, description },
  operation: {
    perform: pollConversations(state),
    sample: { ...CONVERSATION_SAMPLE, ...(state ? { state } : {}) },
    outputFields: CONVERSATION_FIELDS,
  },
});

const EXTERNAL_ID_FIELD = {
  key: 'external_id',
  label: 'External Conversation ID',
  type: 'string',
  required: true,
  helpText: 'Map the external_id field from a Janis trigger or Send Outbound output.',
};

const conversationAction = (key, label, description, suffix, extraFields, bodyFor) => ({
  key,
  noun: 'Conversation',
  display: { label, description },
  operation: {
    inputFields: [EXTERNAL_ID_FIELD, ...(extraFields ?? [])],
    perform: async (z, bundle) => {
      const res = await z.request({
        url: `${BASE}/v1/conversations/${bundle.inputData.external_id}/${suffix}`,
        method: 'POST',
        body: bodyFor ? bodyFor(bundle) : {},
      });
      return res.data;
    },
    sample: { conversation_id: 'email:customer@example.com', state: 'active' },
    outputFields: [
      { key: 'conversation_id', label: 'External Conversation ID' },
      { key: 'state', label: 'State' },
    ],
  },
});

const SendOutbound = {
  key: 'send_outbound_message',
  noun: 'Message',
  display: {
    label: 'Send Outbound Message',
    description: "Starts a new outbound conversation on one of the agent's channels.",
  },
  operation: {
    inputFields: [
      {
        key: 'to',
        label: 'To',
        type: 'string',
        required: true,
        helpText: 'Email address or phone in E.164 format (+15551234567).',
      },
      { key: 'text', label: 'Message', type: 'text', required: true },
      {
        key: 'subject',
        label: 'Subject',
        type: 'string',
        helpText: 'Email subject line — only used by email channels.',
      },
      {
        key: 'channel_id',
        label: 'Channel ID',
        type: 'string',
        helpText: "Leave blank to use the agent's first outbound-capable channel.",
      },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        url: `${BASE}/v1/send`,
        method: 'POST',
        body: {
          to: bundle.inputData.to,
          text: bundle.inputData.text,
          subject: bundle.inputData.subject,
          channel_id: bundle.inputData.channel_id,
        },
      });
      return res.data;
    },
    sample: {
      conversation_id: 'cc7073c9-05a1-4fc4-be2a-caff51ffbb91',
      external_id: 'email:customer@example.com',
      mid: '01a0f3a3-20f8-7310-b725-3ec095f7d382',
      error: null,
    },
    outputFields: [
      { key: 'external_id', label: 'External Conversation ID' },
      { key: 'mid', label: 'Message ID' },
    ],
  },
};

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addApiKey],
  triggers: {
    new_conversation: conversationTrigger(
      'new_conversation',
      'New Conversation',
      'Triggers when a customer starts a new conversation with your agent.',
    ),
    conversation_escalated: conversationTrigger(
      'conversation_escalated',
      'Conversation Escalated',
      'Triggers when a conversation is escalated to a human.',
      'needs_human',
    ),
    conversation_resolved: conversationTrigger(
      'conversation_resolved',
      'Conversation Resolved',
      'Triggers when a conversation is resolved or archived.',
      'archived',
    ),
  },
  creates: {
    send_reply: conversationAction(
      'send_reply',
      'Send Reply',
      'Sends a reply to an existing conversation.',
      'reply',
      [{ key: 'text', label: 'Message', type: 'text', required: true }],
      (b) => ({ text: b.inputData.text }),
    ),
    escalate_conversation: conversationAction(
      'escalate_conversation',
      'Escalate to Human',
      'Escalates a conversation to a human operator.',
      'escalate',
      [
        {
          key: 'reason',
          label: 'Reason',
          type: 'string',
          helpText: 'Why this conversation needs a human.',
        },
      ],
      (b) => ({ reason: b.inputData.reason }),
    ),
    resume_conversation: conversationAction(
      'resume_conversation',
      'Resume AI',
      'Hands a conversation back to the AI agent.',
      'resume',
    ),
    resolve_conversation: conversationAction(
      'resolve_conversation',
      'Resolve Conversation',
      'Archives a conversation and sends the CSAT survey.',
      'resolve',
    ),
    send_outbound_message: SendOutbound,
  },
};
