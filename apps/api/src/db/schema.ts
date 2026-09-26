import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  integer,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'), // key into PLANS rate map
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Agency sub-account: inherits plan/caps from the parent workspace and may
  // not add agents until it buys a plan of its own. parent_contact is the
  // human-facing "who to ask for more" string shown in the UI.
  parentWorkspaceId: uuid('parent_workspace_id').references(
    (): AnyPgColumn => workspaces.id,
  ),
  parentContact: text('parent_contact'),
  // Workspace default LLM config — same shape as agents.config.llm; agent
  // fields override it field-by-field (unset → inherit). api_key is
  // write-only like the agent one.
  llmConfig: jsonb('llm_config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'), // null for OAuth-only accounts
    // {push, email} — which channels alert this user when agents need a human
    notifyPrefs: jsonb('notify_prefs').notNull().default({ push: true, email: true }),
    slackUserId: text('slack_user_id'), // resolved via users.lookupByEmail — cached for alert @mentions
    // Customer-facing operator identity on chats that show it — display_name
    // falls back to the account's first name when unset.
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    // per-operator opt-out — even on channels with show_operator enabled,
    // their replies stay anonymous
    showIdentity: boolean('show_identity').notNull().default(true),
    // last workspace the user was active in — restored on next login
    lastWorkspaceId: uuid('last_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // case-insensitive email uniqueness — entry points normalize, this is the
  // backstop so 'Foo@x' and 'foo@x' can never become two accounts
  (t) => [uniqueIndex('users_email_ci').on(sql`lower(${t.email})`)],
);

/** Workspace membership — a user can belong to many workspaces; the role
 * lives on the membership. acceptedAt null = invited, not yet accepted. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_user_workspace').on(t.userId, t.workspaceId)],
);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // sha256 of the bearer token
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  // which of the user's workspaces this session is acting in — a user with
  // multiple memberships can switch without logging out
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text('name').notNull(),
  // null until the operator generates one — hosted agents may never need it
  apiKeyHash: text('api_key_hash').unique(),
  apiKeyPreview: text('api_key_preview'),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  hosted: boolean('hosted').notNull().default(false), // Janis runs the agent in-process
  // Slack channel override for this agent's alerts — null routes to the
  // installation's workspace-wide alert channel
  slackChannelId: text('slack_channel_id'),
  autoResumeMinutes: integer('auto_resume_minutes').default(10), // auto-release human takeover after N min (null = never)
  // Behavior config for template-based agents: {system_prompt, knowledge[], tone}
  config: jsonb('config').notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }), // last ingest event
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    externalId: text('external_id').notNull(),
    state: text('state', { enum: ['active', 'needs_human', 'human', 'archived'] })
      .notNull()
      .default('active'),
    assigneeId: uuid('assignee_id').references(() => users.id),
    userProfile: jsonb('user_profile').notNull().default({}),
    tags: text('tags').array().notNull().default([]),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    lastMessageDirection: text('last_message_direction', {
      enum: ['in', 'out', 'human'],
    }),
    humanSince: timestamp('human_since', { withTimezone: true }), // last human-side activity during takeover (auto-resume clock)
    resumeWarnedAt: timestamp('resume_warned_at', { withTimezone: true }), // pre-resume warning posted to Slack (legacy warningSent)
    pauseMinutes: integer('pause_minutes'), // per-takeover duration override (null = agent default, -1 = never)
    isStarred: boolean('is_starred').notNull().default(false),
    isUnread: boolean('is_unread').notNull().default(false),
    // Rolling agent memory: everything before summaryUpTo is folded into
    // agentSummary so the hosted agent remembers the whole conversation
    agentSummary: text('agent_summary'),
    summaryUpTo: timestamp('summary_up_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_agent_external').on(t.agentId, t.externalId),
    index('conversations_agent_state').on(t.agentId, t.state),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    direction: text('direction', { enum: ['in', 'out', 'human'] }).notNull(),
    authorId: uuid('author_id').references(() => users.id),
    text: text('text'),
    payload: jsonb('payload').notNull().default({}),
    flags: jsonb('flags')
      .notNull()
      .default({ failure: false, help_requested: false, custom_alert: false, handoff_offer: false }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation').on(t.conversationId, t.createdAt),
    // platform message ids (mid/wamid) dedup inbound events delivered via
    // both the direct webhook and the legacy relay
    uniqueIndex('messages_in_mid')
      .on(t.conversationId, sql`(payload->>'mid')`)
      .where(sql`direction = 'in' and payload->>'mid' is not null`),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    type: text('type', {
      enum: [
        'failure',
        'help_request',
        'handoff_offer',
        'custom',
        'inactivity',
        'keyword',
        'sla',
        'approval_request',
      ],
    }).notNull(),
    detail: text('detail'),
    status: text('status', { enum: ['open', 'acknowledged', 'resolved'] })
      .notNull()
      .default('open'),
    // Where the alert card landed in Slack when it was posted as a reply in
    // the conversation's canonical thread — lets updateSlackAlert refresh
    // its buttons. Null when the alert IS the thread anchor (first alert).
    slackTs: text('slack_ts'),
    slackChannelId: text('slack_channel_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('alerts_conversation_status').on(t.conversationId, t.status),
    // One open alert per type per conversation — the app-level select→insert
    // dedupe races under concurrent event processing, so the DB enforces it.
    uniqueIndex('alerts_one_open_per_type')
      .on(t.conversationId, t.type)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Per-(agent, user) grant + overrides. One row serves three purposes:
 * - role: null = inherit the workspace role; a set role overrides it for
 *   this agent. Users with NO workspace membership can hold agent rows —
 *   they see only the agents listed here (agent-scoped access).
 * - profile override: display_name/avatar_url/show_identity shown to
 *   customers when this operator replies on this agent's channels.
 * - notifyPrefs: {push,email,sound} — null fields inherit user.notify_prefs
 *   for this agent's alerts.
 */
export const agentMembers = pgTable(
  'agent_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['admin', 'member'] }),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    showIdentity: boolean('show_identity'), // null = inherit user.showIdentity
    notifyPrefs: jsonb('notify_prefs'), // null = inherit users.notifyPrefs
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_members_agent_user').on(t.agentId, t.userId)],
);

export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  kind: text('kind', {
    enum: ['keyword', 'failure', 'handoff_request', 'inactivity', 'custom_alert'],
  }).notNull(),
  config: jsonb('config').notNull().default({ enabled: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  endpoint: text('endpoint').notNull().unique(),
  keys: jsonb('keys').notNull(), // { p256dh, auth }
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Long-lived Meta user token per workspace — survives reloads so the asset
// picker can re-discover pages without re-running OAuth.
export const metaConnections = pgTable('meta_connections', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id),
  userToken: text('user_token').notNull(),
  // App-scoped Meta user id — populated at OAuth time so data-deletion
  // callbacks (which identify by user_id, not token) can find the workspace.
  metaUserId: text('meta_user_id'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
});

export const slackInstallations = pgTable('slack_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  teamId: text('team_id').notNull(),
  botToken: text('bot_token').notNull(),
  alertChannelId: text('alert_channel_id'),
  installerUserId: uuid('installer_user_id').references(() => users.id),
  // Slack user token granted at install (user_scope=chat:write) — lets us
  // delete the installer's own thread replies so styled mirrors replace them
  // (bot tokens can only delete messages the bot itself posted).
  installerSlackUserId: text('installer_slack_user_id'),
  installerUserToken: text('installer_user_token'),
  // true once a legacy wordhop-slack team is cut over: the token was imported
  // from Mongo and we own the team's Slack traffic — never fan out to legacy.
  migrated: boolean('migrated').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const suggestions = pgTable('suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  text: text('text').notNull(),
  source: text('source', { enum: ['agent', 'llm'] }).notNull(),
  status: text('status', { enum: ['pending', 'used', 'dismissed'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Agent tool calls that mutate customer data — the agent proposes, a human
// approves/denies, then the call executes (or not) and the agent continues.
export const pendingActions = pgTable('pending_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  // The transcript row carrying the approval card — its payload.action.status
  // is updated on decide so the card resolves in place.
  messageId: uuid('message_id').references(() => messages.id),
  toolName: text('tool_name').notNull(),
  // Snapshot of the tool definition + args at request time — approval executes
  // exactly what the operator saw, not whatever the config has drifted to.
  tool: jsonb('tool').notNull(),
  args: jsonb('args').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] })
    .notNull()
    .default('pending'),
  result: text('result'),
  decidedById: uuid('decided_by_id').references(() => users.id),
  decidedByName: text('decided_by_name'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  // Slack card locations [{channelId, ts}] — updated in place on decide.
  slackPosts: jsonb('slack_posts'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const savedReplies = pgTable('saved_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  // null = workspace-wide; set = scoped to one agent (merged into its
  // conversations' composer alongside the workspace replies)
  agentId: uuid('agent_id').references(() => agents.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const digests = pgTable('digests', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  stats: jsonb('stats').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Slack thread ↔ conversation mapping for threaded takeover. A conversation
// can own many alert threads — every registered thread stays live (mirrors
// fan out to all of them, replies in any of them route back), so nothing an
// operator sees ever goes dead.
export const slackThreads = pgTable(
  'slack_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => slackInstallations.id),
    channelId: text('channel_id').notNull(),
    ts: text('ts').notNull(), // slack message timestamp = thread id
    lastReplyTs: text('last_reply_ts'), // newest reply ts — permalink targets land here
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('slack_threads_channel_ts').on(t.channelId, t.ts)],
);

// Messaging channels hosted by Janis (Meta: Messenger / Instagram / WhatsApp).
// Janis owns the platform webhook; inbound messages are forwarded to the agent
// only while it owns the conversation — enforced gating during takeover.
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  kind: text('kind', { enum: ['messenger', 'instagram', 'whatsapp', 'webchat'] }).notNull(),
  name: text('name').notNull(),
  // {page_id, page_access_token, verify_token, phone_number_id} — secrets never leave the API
  credentials: jsonb('credentials').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// conversation ↔ platform user binding for hosted channels
export const channelBindings = pgTable(
  'channel_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id)
      .unique(),
    platformUserId: text('platform_user_id').notNull(), // PSID / phone number
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_bindings_user').on(t.channelId, t.platformUserId)],
);

// billable usage — one row per metered event (LLM call, etc.)
// cost is locked at write time so rate-card changes never rewrite history
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id').references(() => agents.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    kind: text('kind', { enum: ['llm_tokens'] }).notNull(),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    // USD * 1e6, from the rate card at write time
    costMicros: integer('cost_micros').notNull().default(0),
    period: text('period').notNull(), // 'YYYY-MM' for monthly rollups
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_events_ws_period').on(t.workspaceId, t.period)],
);

// Uploaded knowledge files for hosted agents — extracted text is injected
// into the system prompt at reply time.
export const knowledgeFiles = pgTable(
  'knowledge_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    text: text('text').notNull().default(''),
    status: text('status', { enum: ['ready', 'failed'] }).notNull().default('ready'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_files_agent').on(t.agentId)],
);

// Per-agent secrets (API keys for tool calls) — AES-256-GCM encrypted at rest.
// Write-only via the API: values are never returned after creation.
export const agentSecrets = pgTable(
  'agent_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    valueEnc: text('value_enc').notNull(), // base64 iv.tag.ciphertext
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_secrets_agent_name').on(t.agentId, t.name)],
);

// OAuth connections powering agent tools — server-to-server providers mint
// and cache access tokens here (client_id/secret stay encrypted, tokens are
// refreshed on demand). Tools reference {{secrets.CONN_<PROVIDER>_TOKEN}}.
export const agentConnections = pgTable(
  'agent_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    provider: text('provider').notNull(), // 'zendesk-oauth' | 'salesforce' | …
    label: text('label'), // subdomain/instance host, for display
    credentialsEnc: text('credentials_enc').notNull(), // encrypted JSON {host, client_id, client_secret}
    accessTokenEnc: text('access_token_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_connections_agent_provider').on(t.agentId, t.provider)],
);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status', { enum: ['pending', 'delivered', 'failed'] })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Uploaded file blobs — attachments live in Postgres (not the container
 * filesystem, which is ephemeral on Cloud Run) so transcript links survive
 * deploys. `filename` is the generated public name in /uploads/<filename>.
 */
export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  size: integer('size').notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
