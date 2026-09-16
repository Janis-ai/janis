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
} from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'), // key into PLANS rate map
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'), // null for OAuth-only accounts
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  // {push, email} — which channels alert this user when agents need a human
  notifyPrefs: jsonb('notify_prefs').notNull().default({ push: true, email: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // sha256 of the bearer token
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  apiKeyPreview: text('api_key_preview').notNull(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  hosted: boolean('hosted').notNull().default(false), // Janis runs the agent in-process
  autoResumeMinutes: integer('auto_resume_minutes'), // auto-release human takeover after N min
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
    isStarred: boolean('is_starred').notNull().default(false),
    isUnread: boolean('is_unread').notNull().default(false),
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
      .default({ failure: false, help_requested: false, custom_alert: false }),
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
      enum: ['failure', 'help_request', 'custom', 'inactivity', 'keyword'],
    }).notNull(),
    detail: text('detail'),
    status: text('status', { enum: ['open', 'acknowledged', 'resolved'] })
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alerts_conversation_status').on(t.conversationId, t.status)],
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

export const savedReplies = pgTable('saved_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
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

// Slack thread ↔ conversation mapping for threaded takeover
export const slackThreads = pgTable('slack_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id)
    .unique(),
  installationId: uuid('installation_id')
    .notNull()
    .references(() => slackInstallations.id),
  channelId: text('channel_id').notNull(),
  ts: text('ts').notNull(), // slack message timestamp = thread id
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  kind: text('kind', { enum: ['messenger', 'instagram', 'whatsapp'] }).notNull(),
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
