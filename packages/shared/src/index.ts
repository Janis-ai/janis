import { z } from 'zod';
import { EFFORT_LEVELS } from './models.js';

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
  'handoff_offer', // agent offered a human — customer hasn't confirmed yet
  'custom', // agent-defined custom alert
  'sla', // needs_human went unclaimed past the agent's SLA — re-alert/escalation
  'inactivity', // conversation went quiet while awaiting agent
  'keyword', // a configured keyword/phrase was matched
  'approval_request', // a gated tool call is parked awaiting teammate approval
]);
export type AlertType = z.infer<typeof AlertType>;

export const AlertStatus = z.enum(['open', 'acknowledged', 'resolved']);
export type AlertStatus = z.infer<typeof AlertStatus>;

// ---------------------------------------------------------------------------
// Ingestion — events an agent sends to Janis (POST /v1/events)
// ---------------------------------------------------------------------------

/** Normalized end-user profile stored on a conversation. All fields optional —
 *  platforms supply different subsets (Meta never exposes email). */
export const UserProfile = z
  .object({
    id: z.string().optional(), // platform user id (PSID / IGSID / wa_id) or client id
    name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(), // instagram handle
    email: z.string().optional(),
    phone: z.string().optional(), // whatsapp number
    channel: z.string().optional(), // messenger | instagram | whatsapp | external
    channel_name: z.string().optional(), // page/account the customer messaged
    picture_url: z.string().optional(), // raw CDN url — internal, stripped in API
    profile_fetched_at: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type UserProfile = z.infer<typeof UserProfile>;

const eventBase = {
  /** Client's own conversation/user identifier; created if unseen. */
  conversation_id: z.string().min(1).max(256),
  /** Optional end-user profile shown to the human operator. Merged into the
   *  conversation's stored profile — later events only overwrite the fields
   *  they actually carry. */
  user: UserProfile.optional(),
  /** ISO timestamp; defaults to server receive time. */
  timestamp: z.string().datetime({ offset: true }).optional(),
};

export const MessageInEvent = z.object({
  type: z.literal('message_in'),
  text: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  ...eventBase,
});

/** A tappable option on an outbound message's quick_replies. A plain string
 * renders as a labelled quick reply; {type:'email'|'phone'} asks the
 * customer to share that contact field via the channel's native affordance
 * (Messenger user_email/user_phone_number quick replies, an inline field on
 * webchat) — channels without one just show the agent's text asking. */
export const QuickReply = z.union([
  z.string().min(1),
  z.object({ type: z.enum(['email', 'phone']) }),
]);
export type QuickReply = z.infer<typeof QuickReply>;

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

export const HandoffOfferEvent = z.object({
  type: z.literal('handoff_offer'),
  reason: z.string().optional(),
  ...eventBase,
});

export const HandoffCancelledEvent = z.object({
  type: z.literal('handoff_cancelled'),
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

/** The agent/operator declares the conversation resolved — archives it and
 *  fires the CSAT prompt. Emitted by hosted agents on [END_CHAT] and by the
 *  widget's "End chat" control. */
export const ResolveEvent = z.object({
  type: z.literal('resolve'),
  reason: z.string().optional(),
  ...eventBase,
});

export const IngestEvent = z.discriminatedUnion('type', [
  MessageInEvent,
  MessageOutEvent,
  FailureEvent,
  HandoffRequestEvent,
  HandoffOfferEvent,
  HandoffCancelledEvent,
  CustomAlertEvent,
  ResolveEvent,
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
  /** true when the workspace's hard message cap dropped this event before
   * storage — results[] stays index-aligned with the submitted events */
  capped: z.boolean().optional(),
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
  // Per-agent help-center domain override — beats the workspace-level
  // help_domain when both are set. Bare domain only (help.acme.com).
  help_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, 'must be a bare domain like help.acme.com')
    .max(200)
    .nullable()
    .optional(),
  // External help link — the widget's "Browse help articles" button points
  // here instead of the built-in centre, and shows even with no published
  // articles. Full URL (https://help.acme.com); null clears.
  help_url: z.string().trim().url().max(500).nullable().optional(),
  // hosted agents only — per-agent LLM override (OpenAI-compatible).
  // api_key is write-only: reads return key_set instead. null clears the key.
  llm: z
    .object({
      api_key: z.string().nullish(),
      base_url: z.string().optional(),
      model: z.string().optional(),
      // reasoning effort for effort-capable models — sent as the provider's
      // effort param (snapped to the levels the model supports)
      effort: z.enum(EFFORT_LEVELS).optional(),
      provider: z.string().optional(), // preset id ('openai', 'gemini', …) — UI metadata
      key_set: z.boolean().optional(), // read marker — never accepted on write
    })
    .optional(),
  // hosted agents only — client systems the agent can call (POS/CRM/etc).
  // url may contain {param} placeholders filled from tool-call args.
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        url: z.string(),
        // static headers (auth etc.) — secrets stay server-side
        headers: z.record(z.string(), z.string()).optional(),
        // JSON-schema-ish params the model fills: {order_id: 'order number'}
        params: z.record(z.string(), z.string()).optional(),
        // POST/PUT/PATCH body encoding — 'form' for APIs like Stripe
        bodyFormat: z.enum(['json', 'form']).optional(),
        // mutating tools park as pending actions until a teammate decides
        approval: z.boolean().optional(),
        // catalog template id that installed this tool — managed via the
        // integrations UI, hidden from the custom-tools JSON editor
        template: z.string().optional(),
      }),
    )
    .optional(),
  // hosted agents only — server-side built-in tools by name (e.g.
  // 'web_search'). Unlike `tools` these run in-process — no URL or secrets.
  builtin_tools: z.array(z.string()).optional(),
  // escalation: re-alert when a handoff stays unclaimed past N minutes
  sla_minutes: z.number().min(1).max(1440).optional(),
  // When on, the agent ends resolved chats itself — [END_CHAT] archives the
  // conversation (CSAT fires) once the customer confirms they're done.
  auto_archive: z.boolean().optional(),
  // eval suite: replay saved regression tests every N hours (unset = off).
  // Scheduled runs record to agent_test_runs and alert on pass-rate drops.
  eval_interval_hours: z.number().min(1).max(720).optional(),
  // routing: assign handoffs to the least-loaded workspace member
  auto_assign: z.boolean().optional(),
  // post-resolution satisfaction survey — per-agent override of the
  // workspace-level csat block (unset fields inherit the workspace's)
  csat: z
    .object({
      enabled: z.boolean().optional(), // unset → workspace default → on
      prompt: z.string().max(500).optional(),
      thanks: z.string().max(500).optional(),
    })
    .optional(),
  // intent taxonomy — labels the classifier picks from on each conversation's
  // first inbound. Empty/unset uses the default support taxonomy.
  intents: z.array(z.string().min(1).max(60)).max(30).optional(),
  // suggested prompts — chips in the webchat widget; native reply buttons on
  // Messenger/IG/WhatsApp greetings (channel-level quick_replies overrides)
  quick_replies: z.array(z.string().min(1).max(120)).max(8).optional(),
  // first message sent when a conversation starts — channel greeting overrides.
  // Blank = hosted agents generate one in their persona; BYOK gets the default.
  greeting: z.string().max(500).optional(),
  // set false to start conversations silently (default on)
  greeting_enabled: z.boolean().optional(),
  // runtime engine: default hosted LLM; 'dialogflow' answers inbound via a
  // migrated legacy Dialogflow ES bot; 'monitor' = migrated Chatfuel/ManyChat
  // bot where the bot platform replies itself — Janis observes, runs the
  // /messenger/client/* fallback endpoints, and tracks takeovers.
  engine: z.enum(['hosted', 'dialogflow', 'monitor']).optional(),
  dialogflow: z
    .object({
      project: z.string(),
      lang: z.string().default('en'),
    })
    .optional(),
  // migrated wordhopapi bot bookkeeping (see apps/api/src/routes/legacy.ts)
  legacy: z
    .object({
      client_key: z.string(),
      code_lang: z.string().optional(), // 'chatfuel' | 'manychat' | ...
      // page-inbox pauses auto-resume after N minutes (legacy default ~5)
      takeover_timeout: z.number().min(1).max(1440).optional(),
    })
    .optional(),
  // knowledge-gap UI: dismissed "LEARN:" self-reports and gap clusters stay
  // hidden by key. dismissed_gap_times records when each key was dismissed —
  // a gap resurfaces only if it escalates again after that, not when a new
  // phrasing of the same question merely appears.
  dismissed_learnings: z.array(z.string().max(400)).optional(),
  dismissed_gaps: z.array(z.string().max(400)).optional(),
  dismissed_gap_times: z.record(z.string(), z.string()).optional(),
  // conversation ids the operator dismissed from the tests tab's "rescued,
  // untested" suggestions — keeps the list from nagging about convs they've
  // deliberately decided aren't worth a regression test.
  dismissed_test_suggestions: z.array(z.string()).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/** Deterministic friendly handle for anonymous contacts — "Calm Otter a48f".
 * Short, readable, and stable per external_id so two anonymous visitors in a
 * list are distinguishable without exposing the raw platform id. */
const FRIENDLY_ADJ = [
  'Amber', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Cozy', 'Daring',
  'Eager', 'Gentle', 'Golden', 'Happy', 'Jolly', 'Keen', 'Lively', 'Lucky',
  'Merry', 'Misty', 'Noble', 'Proud', 'Quiet', 'Rapid', 'Sunny', 'Swift',
];
const FRIENDLY_ANIMAL = [
  'Badger', 'Bear', 'Bison', 'Crane', 'Deer', 'Eagle', 'Finch', 'Fox',
  'Hare', 'Heron', 'Lark', 'Lynx', 'Moose', 'Newt', 'Otter', 'Owl',
  'Panda', 'Quail', 'Raven', 'Robin', 'Seal', 'Tiger', 'Wolf', 'Wren',
];
export function friendlyName(externalId: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < externalId.length; i++) {
    h ^= externalId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const adj = FRIENDLY_ADJ[h % FRIENDLY_ADJ.length];
  const animal = FRIENDLY_ANIMAL[(h >>> 8) % FRIENDLY_ANIMAL.length];
  return `${adj} ${animal} ${h.toString(16).padStart(8, '0').slice(-4)}`;
}

export const Agent = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  webhook_url: z.string().nullable(),
  has_webhook_secret: z.boolean(),
  hosted: z.boolean(), // Janis runs the agent in-process (no webhook needed)
  auto_resume_minutes: z.number().nullable(),
  // Slack alert destinations: null = workspace default install+channel,
  // [] = no Slack alerts for this agent, otherwise the exact list —
  // channel_id null means that installation's own alert channel
  slack_routes: z
    .array(z.object({ installation_id: z.string(), channel_id: z.string().nullable() }))
    .nullable(),
  // the owning user — always effectively an admin; transfers ownership only
  owner_user_id: z.string().nullable(),
  config: AgentConfig,
  last_seen_at: z.string().nullable(), // last ingest event received
  api_key_preview: z.string().nullable(), // null until a key is generated; full key shown once on generate/rotate
  metadata: z.record(z.unknown()),
  created_at: z.string(),
});
export type Agent = z.infer<typeof Agent>;

/** A hosted messaging channel (Meta), embeddable webchat, or inbound email. Tokens are never exposed to the console. */
export const Channel = z.object({
  id: z.string(),
  kind: z.enum(['messenger', 'instagram', 'whatsapp', 'webchat', 'email', 'gmail', 'outlook', 'voice', 'sms']),
  name: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  // non-secret identifiers + the verify token needed to register the webhook
  meta: z.object({
    page_id: z.string().optional(),
    phone_number_id: z.string().optional(),
    // instagram handle + whatsapp display number — public, used for launch links
    username: z.string().optional(),
    phone_number: z.string().optional(),
    verify_token: z.string(),
    via: z.enum(['oauth', 'manual']).optional(),
    chat_url: z.string().optional(), // where a customer opens a chat with this channel
    // webchat: shared secret for HMAC-signed visitor identity — visible to
    // workspace members (like verify_token), never to widget visitors
    identity_secret: z.string().optional(),
    // voice: Janis provisioned the number — no Twilio console setup needed
    hosted: z.boolean().optional(),
    // webchat: show operator name/avatar on human replies — off by default
    show_operator: z.boolean().optional(),
    // email: the channel's unique inbound address + From display name
    inbound_address: z.string().optional(),
    // email: readable per-channel reply address — used as From and Reply-To
    reply_address: z.string().optional(),
    // gmail: the connected mailbox address (oauth identity)
    email_address: z.string().optional(),
    from_name: z.string().optional(),
    // email channels: send-as From override + inbound answer rules
    from_address: z.string().optional(),
    gmail_query: z.string().optional(),
    email_filters: z
      .object({
        answer_addresses: z.array(z.string()).optional(),
        list_mail: z.boolean().optional(),
        sender_allow: z.array(z.string()).optional(),
        sender_block: z.array(z.string()).optional(),
        subject_exclude: z.array(z.string()).optional(),
      })
      .optional(),
    // email (resend): client-branded sending domain + verification state
    email_domain: z.string().optional(),
    email_domain_status: z.string().optional(),
    email_domain_records: z
      .array(
        z.object({
          record: z.string().optional(),
          name: z.string(),
          type: z.string(),
          value: z.string(),
          ttl: z.string().optional(),
          priority: z.number().optional(),
          status: z.string().optional(),
        }),
      )
      .optional(),
    // Cloudflare OAuth connected for one-click DNS setup (token never leaves creds)
    cf_connected: z.boolean().optional(),
    // email: upstream mailbox BCC'd on replies (auto-detected forward origin)
    mirror_address: z.string().optional(),
    // webchat widget appearance — display config only, never secrets
    branding: z
      .object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        greeting: z.string().optional(),
        accent: z.string().optional(),
        position: z.enum(['left', 'right']).optional(),
        logo_url: z.string().optional(),
        // logo tile (header) + launcher inset
        logo_padding: z.number().optional(),
        logo_radius: z.number().optional(),
        logo_border_width: z.number().optional(),
        logo_border_color: z.string().optional(),
        quick_replies: z.array(z.string()).optional(),
        teaser_text: z.string().optional(),
        proactive: z.boolean().optional(),
        proactive_delay: z.number().optional(),
        sound: z.boolean().optional(),
        // light (default) | dark | auto (follows the visitor's OS setting)
        theme: z.enum(['light', 'dark', 'auto']).optional(),
        // paid plans only — the bootstrap strips the flag on free workspaces
        hide_powered_by: z.boolean().optional(),
        // show the "Browse help articles" link — default on
        show_help_link: z.boolean().optional(),
        // mic dictation in the widget — opt-in: transcription runs on
        // Janis's keys and is metered to the workspace
        dictation: z.boolean().optional(),
      })
      .optional(),
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
  user_profile: UserProfile,
  /** True when a profile picture exists — fetch it via /api/conversations/:id/avatar */
  has_avatar: z.boolean(),
  tags: z.array(z.string()),
  last_message_at: z.string().nullable(),
  last_message_preview: z.string().nullable(),
  open_alert_count: z.number(),
  is_starred: z.boolean(),
  is_unread: z.boolean(),
  human_since: z.string().nullable(),
  /** Snoozed until (ISO) — actively-snoozed conversations hide from every
   * queue except the Snoozed view; a new inbound message wakes them */
  snoozed_until: z.string().nullable(),
  /** 1–5 rating captured from the post-resolution CSAT prompt, if answered */
  csat_score: z.number().nullable(),
  csat_pending: z.boolean(),
  /** Semantic topic label — set by the classifier or a BYO agent's payload. */
  intent: z.string().nullable(),
  /** Who set intent: 'ai' (drift re-checks may update), 'byo', or 'manual'. */
  intent_source: z.string().optional(),
  /** Unified customer record this conversation's identity resolved to. */
  contact_id: z.string().nullable().optional(),
  created_at: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

/** A named filter preset for the conversations list — per-operator.
 * `filters` mirrors the GET /api/conversations query params. */
export const SavedView = z.object({
  id: z.string(),
  name: z.string(),
  filters: z.object({
    state: z.string().optional(),
    agent_id: z.string().optional(),
    assignee: z.string().optional(),
    attention: z.boolean().optional(),
    tab: z.string().optional(),
    query: z.string().optional(),
  }),
  created_at: z.string(),
});
export type SavedView = z.infer<typeof SavedView>;

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
    handoff_offer: z.boolean(),
    handoff_cancelled: z.boolean(),
    resolved: z.boolean(),
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
  notes: z.string().nullable(),
  source: z.enum(['agent', 'llm']),
  status: z.enum(['pending', 'used', 'dismissed']),
  created_at: z.string(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const AlertRule = z.object({
  id: z.string(),
  agent_id: z.string(),
  kind: z.enum(['keyword', 'failure', 'handoff_request', 'inactivity', 'custom_alert', 'auto_assign']),
  config: z.object({
    keywords: z.array(z.string()).optional(),
    // semantic topic matches — classifier labels like 'billing', 'shipping'
    intents: z.array(z.string()).optional(),
    inactivity_minutes: z.number().optional(),
    // automation actions — keyword matches / inactivity fires / new
    // conversations can assign the thread or tag it
    assign_to: z.string().optional(), // user id
    assignees: z.array(z.string()).optional(), // auto_assign: round-robin pool
    tag: z.string().optional(),
    enabled: z.boolean(),
  }),
  created_at: z.string(),
});
export type AlertRule = z.infer<typeof AlertRule>;

/** Public help-center article — published rows are served unauthenticated
 *  and injected into the agent's knowledge context. */
export const HelpArticle = z.object({
  id: z.string(),
  agent_id: z.string(),
  title: z.string(),
  slug: z.string().nullable(),
  category: z.string(),
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  body: z.string(),
  status: z.enum(['draft', 'published']),
  view_count: z.number().default(0),
  published_at: z.string().nullable(),
  updated_at: z.string(),
});
export type HelpArticle = z.infer<typeof HelpArticle>;

export const SavedReply = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  // set when scoped to one agent — workspace replies have null
  agent_id: z.string().nullable().optional(),
  created_at: z.string(),
});
export type SavedReply = z.infer<typeof SavedReply>;

/** A user's grant/overrides on one agent (agent_members row + user fields).
 *  role null = inherit workspace role; 'hidden' = explicitly denied;
 *  'owner' comes from agents.owner_user_id (the owner may hold no row).
 *  identity/notify fields null = inherit the user's own profile/prefs. */
export const AgentMember = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'member', 'hidden']).nullable(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  avatar_override: z.string().nullable(),
  show_identity: z.boolean().nullable(),
  notify: z
    .object({
      push: z.boolean().optional(),
      email: z.boolean().optional(),
      sound: z.boolean().optional(),
    })
    .nullable(),
  status: z.enum(['active', 'invited']),
});
export type AgentMember = z.infer<typeof AgentMember>;

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

export const WebhookDelivery = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number(),
  last_error: z.string().nullable(),
  next_attempt_at: z.string().nullable().optional(),
  payload: z.unknown().optional(),
  created_at: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

// Agent secrets are write-only — only name + timestamps are ever returned.
export const AgentSecretMeta = z.object({
  name: z.string(),
  created_at: z.string(),
});
export type AgentSecretMeta = z.infer<typeof AgentSecretMeta>;

// Predefined tool connections — the public catalog view. The server keeps
// the full ToolDefs + secret-derivation logic; clients only see fields and
// tool previews.
export const ToolTemplateField = z.object({
  key: z.string(),
  label: z.string(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
});
export type ToolTemplateField = z.infer<typeof ToolTemplateField>;

export const ToolTemplateInfo = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  blurb: z.string(),
  docs_url: z.string().optional(),
  // 'oauth' templates mint client-credentials tokens onto agent_connections
  auth: z.enum(['secrets', 'oauth']).optional(),
  fields: z.array(ToolTemplateField),
  tools: z.array(
    z.object({
      name: z.string(),
      label: z.string().optional(),
      description: z.string(),
      approval: z.boolean().optional(),
    }),
  ),
});
export type ToolTemplateInfo = z.infer<typeof ToolTemplateInfo>;

export const WorkspaceUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  // 'owner' = workspaces.owner_user_id — can't be demoted or removed
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  // 'invited' = pending membership they haven't accepted yet
  status: z.enum(['active', 'invited']).default('active'),
  notify: z
    .object({ push: z.boolean(), email: z.boolean(), sound: z.boolean() })
    .default({ push: true, email: true, sound: true }),
  // What customers see on operator replies when the channel shows operator
  // identity — defaults to the account's first name and no avatar.
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  // false = stay anonymous even on channels with show_operator enabled
  show_identity: z.boolean().optional(),
  // account creation — the console uses it to fire a once-per-user sign_up
  // analytics event instead of guessing at "new".
  created_at: z.string().optional(),
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
  user: UserProfile.optional(), // end-user info on message.user (picture_url omitted)
  channel: z
    .object({ kind: z.string(), name: z.string() })
    .optional(), // hosted channel the message arrived on, if any
  payload: z.record(z.unknown()).optional(),
  timestamp: z.string(),
});
export type OutboundWebhook = z.infer<typeof OutboundWebhook>;

// ---------------------------------------------------------------------------
// Realtime — SSE events pushed to the console
// ---------------------------------------------------------------------------

/** One notification shape per alert — in-app toasts, web push, and email all
 * render this same payload so the channels mirror each other. */
export const NotificationPayload = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string().optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayload>;

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: Message }),
  z.object({
    type: z.literal('conversation'),
    data: z.object({ id: z.string(), state: ConversationState }),
  }),
  z.object({
    type: z.literal('alert'),
    data: Alert.extend({ notification: NotificationPayload.optional() }),
  }),
  z.object({ type: z.literal('suggestion'), data: Suggestion }),
  // Ephemeral typing pings — 'visitor' for a customer composing, 'agent'
  // for a dispatched message.user the agent hasn't answered yet, 'operator'
  // for a teammate composing in the console (collision detection). Clients
  // show them transiently and never persist them.
  z.object({
    type: z.literal('typing'),
    data: z.object({
      conversation_id: z.string(),
      name: z.string().optional(),
      kind: z.enum(['visitor', 'agent', 'operator']).optional(),
      // the typer's Janis account when session-bound — lets the console
      // suppress visitor dots for your own rail/test-chat typing
      user_id: z.string().nullable().optional(),
    }),
  }),
  // Co-presence — who's viewing a conversation right now. Broadcast on
  // change; entries expire server-side ~20s after the last heartbeat.
  z.object({
    type: z.literal('presence'),
    data: z.object({
      conversation_id: z.string(),
      viewers: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
    }),
  }),
  // An eval-suite batch completed — the tests tab refreshes its run history.
  // regressed means the workspace was also alerted (push/email + janis.alert log).
  z.object({
    type: z.literal('eval'),
    data: z.object({ agent_id: z.string(), batch_id: z.string(), regressed: z.boolean() }),
  }),
  // An agent's config changed out-of-band (concierge teach_agent/create_agent)
  // — open agent pages refetch so the KB and gap views aren't stale.
  z.object({ type: z.literal('agent'), data: z.object({ id: z.string() }) }),
  // Workspace-level state changed — plan, usage caps, plan-gated UI.
  // Published by billing writes and concierge change_plan.
  z.object({ type: z.literal('workspace'), data: z.object({ id: z.string() }) }),
  // A channel changed out-of-band (concierge update_channel — rename,
  // widget title) — open channel lists/details refetch.
  z.object({ type: z.literal('channel'), data: z.object({ id: z.string() }) }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

/** Fallback intent taxonomy when an agent doesn't configure config.intents —
 * the API classifier and the console's override dropdown share this list. */
export const DEFAULT_INTENTS = [
  'billing',
  'shipping',
  'order status',
  'returns',
  'technical issue',
  'account',
  'cancellation',
  'sales',
  'feedback',
  'other',
];

export * from './models.js';
