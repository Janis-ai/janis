import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

export const ConversationState = z.enum([
  'active', // agent is handling the conversation
  'needs_human', // an alert fired; no human has taken over yet
  'human', // a human has taken over; agent should stay quiet
  'archived',
]);
export type ConversationState = z.infer<typeof ConversationState>;

export const Attachment = z.object({
  name: z.string(),
  url: z.string(),
  type: z.string(),
  size: z.number(),
});
export type Attachment = z.infer<typeof Attachment>;

export const MessageDirection = z.enum(['in', 'out', 'human']);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const AlertType = z.enum([
  'failure', // agent reported an error / couldn't handle
  'help_request', // user explicitly asked for a human
  'custom', // agent-defined custom alert
  'inactivity', // conversation went quiet while awaiting agent
  'keyword', // a configured keyword/phrase was matched
]);
export type AlertType = z.infer<typeof AlertType>;

export const AlertStatus = z.enum(['open', 'acknowledged', 'resolved']);
export type AlertStatus = z.infer<typeof AlertStatus>;

// ---------------------------------------------------------------------------
// Ingestion — events an agent sends to Janis (POST /v1/events)
// ---------------------------------------------------------------------------

const eventBase = {
  /** Client's own conversation/user identifier; created if unseen. */
  conversation_id: z.string().min(1).max(256),
  /** Optional end-user profile shown to the human operator. */
  user: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
  /** ISO timestamp; defaults to server receive time. */
  timestamp: z.string().datetime({ offset: true }).optional(),
};

export const MessageInEvent = z.object({
  type: z.literal('message_in'),
  text: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  ...eventBase,
});

export const MessageOutEvent = z.object({
  type: z.literal('message_out'),
  text: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  ...eventBase,
});

export const FailureEvent = z.object({
  type: z.literal('failure'),
  reason: z.string().optional(),
  text: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  ...eventBase,
});

export const HandoffRequestEvent = z.object({
  type: z.literal('handoff_request'),
  reason: z.string().optional(),
  ...eventBase,
});

export const CustomAlertEvent = z.object({
  type: z.literal('custom_alert'),
  alert_type: z.string().min(1).max(64),
  text: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  ...eventBase,
});

export const IngestEvent = z.discriminatedUnion('type', [
  MessageInEvent,
  MessageOutEvent,
  FailureEvent,
  HandoffRequestEvent,
  CustomAlertEvent,
]);
export type IngestEvent = z.infer<typeof IngestEvent>;

export const IngestRequest = z.object({
  events: z.array(IngestEvent).min(1).max(500),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

/** Per-event result; `paused` tells the agent a human has taken over. */
export const IngestResult = z.object({
  conversation_id: z.string(),
  paused: z.boolean(),
  conversation_state: ConversationState,
  alert_ids: z.array(z.string()),
});
export type IngestResult = z.infer<typeof IngestResult>;

export const IngestResponse = z.object({
  results: z.array(IngestResult),
});
export type IngestResponse = z.infer<typeof IngestResponse>;

// ---------------------------------------------------------------------------
// Entities returned by the console API
// ---------------------------------------------------------------------------

/** Behavior config for template-based agents — the Dialogflow-era "intents" replacement. */
export const AgentConfig = z.object({
  system_prompt: z.string().optional(),
  knowledge: z.array(z.string()).optional(), // facts/snippets injected into the prompt
  tone: z.string().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const Agent = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  webhook_url: z.string().nullable(),
  has_webhook_secret: z.boolean(),
  auto_resume_minutes: z.number().nullable(),
  config: AgentConfig,
  api_key_preview: z.string(), // e.g. "jk_live_…a1b2" — full key only shown at creation
  metadata: z.record(z.unknown()),
  created_at: z.string(),
});
export type Agent = z.infer<typeof Agent>;

/** A hosted messaging channel (Meta). Tokens are never exposed to the console. */
export const Channel = z.object({
  id: z.string(),
  kind: z.enum(['messenger', 'instagram', 'whatsapp']),
  name: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  // non-secret identifiers + the verify token needed to register the webhook
  meta: z.object({
    page_id: z.string().optional(),
    phone_number_id: z.string().optional(),
    verify_token: z.string(),
  }),
  created_at: z.string(),
});
export type Channel = z.infer<typeof Channel>;

export const Conversation = z.object({
  id: z.string(),
  agent_id: z.string(),
  external_id: z.string(),
  state: ConversationState,
  assignee_id: z.string().nullable(),
  user_profile: z.record(z.unknown()),
  tags: z.array(z.string()),
  last_message_at: z.string().nullable(),
  last_message_preview: z.string().nullable(),
  open_alert_count: z.number(),
  is_starred: z.boolean(),
  is_unread: z.boolean(),
  human_since: z.string().nullable(),
  created_at: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

export const Message = z.object({
  id: z.string(),
  conversation_id: z.string(),
  direction: MessageDirection,
  author: z.string().nullable(), // user id for 'human' messages
  text: z.string().nullable(),
  payload: z.record(z.unknown()),
  flags: z.object({
    failure: z.boolean(),
    help_requested: z.boolean(),
    custom_alert: z.boolean(),
  }),
  created_at: z.string(),
});
export type Message = z.infer<typeof Message>;

export const Alert = z.object({
  id: z.string(),
  conversation_id: z.string(),
  type: AlertType,
  detail: z.string().nullable(),
  status: AlertStatus,
  created_at: z.string(),
});
export type Alert = z.infer<typeof Alert>;

export const Suggestion = z.object({
  id: z.string(),
  conversation_id: z.string(),
  text: z.string(),
  source: z.enum(['agent', 'llm']),
  status: z.enum(['pending', 'used', 'dismissed']),
  created_at: z.string(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const AlertRule = z.object({
  id: z.string(),
  agent_id: z.string(),
  kind: z.enum(['keyword', 'failure', 'handoff_request', 'inactivity', 'custom_alert']),
  config: z.object({
    keywords: z.array(z.string()).optional(),
    inactivity_minutes: z.number().optional(),
    enabled: z.boolean(),
  }),
  created_at: z.string(),
});
export type AlertRule = z.infer<typeof AlertRule>;

export const SavedReply = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export type SavedReply = z.infer<typeof SavedReply>;

export const Digest = z.object({
  id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  stats: z.object({
    conversations: z.number(),
    messages_in: z.number(),
    messages_out: z.number(),
    messages_human: z.number(),
    alerts: z.number(),
    takeovers: z.number(),
  }),
  created_at: z.string(),
});
export type Digest = z.infer<typeof Digest>;

export const WorkspaceUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'member']),
});
export type WorkspaceUser = z.infer<typeof WorkspaceUser>;

// ---------------------------------------------------------------------------
// Outbound webhooks — Janis → agent webhook_url (HMAC-SHA256 signed)
// ---------------------------------------------------------------------------

export const OutboundWebhookType = z.enum([
  'message.user', // hosted-channel inbound: end user sent a message; agent should reply via /v1/events
  'human.takeover', // a human took over; agent should pause for this conversation
  'message.human', // a human operator sent a message to the end user
  'human.resume', // human released the conversation; agent may resume
  'agent.send', // operator asked the agent to deliver `text` to the end user verbatim
  'suggestion.request', // operator asked for a suggested reply; agent POSTs it to /v1/suggestions
]);
export type OutboundWebhookType = z.infer<typeof OutboundWebhookType>;

export const OutboundWebhook = z.object({
  type: OutboundWebhookType,
  conversation_id: z.string(), // the client's external_id
  janis_conversation_id: z.string(),
  text: z.string().optional(),
  operator: z.object({ id: z.string(), name: z.string() }).optional(),
  user: z
    .object({ id: z.string().optional(), name: z.string().optional() })
    .optional(), // end-user info on message.user
  payload: z.record(z.unknown()).optional(),
  timestamp: z.string(),
});
export type OutboundWebhook = z.infer<typeof OutboundWebhook>;

// ---------------------------------------------------------------------------
// Realtime — SSE events pushed to the console
// ---------------------------------------------------------------------------

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: Message }),
  z.object({
    type: z.literal('conversation'),
    data: z.object({ id: z.string(), state: ConversationState }),
  }),
  z.object({ type: z.literal('alert'), data: Alert }),
  z.object({ type: z.literal('suggestion'), data: Suggestion }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
