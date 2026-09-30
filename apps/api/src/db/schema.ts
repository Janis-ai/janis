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
  bigserial,
  primaryKey,
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
  // Agency rebilling (Stripe Connect, GHL-style): the agency's Express
  // account. Client workspaces check out on it as direct charges at
  // agency-set retail prices; application_fee_percent keeps our wholesale.
  stripeConnectId: text('stripe_connect_id'),
  connectChargesEnabled: boolean('connect_charges_enabled').notNull().default(false),
  // {[planKey]: {price_id, retail_cents}} — the agency's own price objects
  // on their connected account; retail floor = our plan's baseCents.
  trialedAt: timestamp('trialed_at', { withTimezone: true }), // one free trial per workspace, ever
  agencyPricing: jsonb('agency_pricing').notNull().default({}),
  // On CLIENT workspaces: the customer/subscription created on the parent's
  // connected account by a direct-charge checkout.
  connectCustomerId: text('connect_customer_id'),
  connectSubscriptionId: text('connect_subscription_id'),
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
  // Workspace-wide integration settings — {event_webhook_url} posts every
  // inbound message/handoff as JSON to a Zapier/Make catch hook
  config: jsonb('config').notNull().default({}),
  // The owning user — exactly one per workspace, kept here (not as a
  // membership role) so transfer is one atomic update. Owners hold an
  // admin membership that can't be demoted or removed; only the owner can
  // hand ownership to another member.
  ownerUserId: uuid('owner_user_id').references((): AnyPgColumn => users.id, {
    onDelete: 'set null',
  }),
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
    role: text('role', { enum: ['admin', 'member', 'viewer'] }).notNull().default('member'),
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
  // installation's workspace-wide alert channel. Legacy columns, kept for
  // rollback; slack_routes is authoritative.
  slackChannelId: text('slack_channel_id'),
  // Slack workspace override — null uses the workspace's default installation
  // (earliest connected); set routes this agent's alerts/threads there
  slackInstallationId: uuid('slack_installation_id').references(
    () => slackInstallations.id,
    { onDelete: 'set null' },
  ),
  // Alert destinations: null = workspace default install+channel, [] = no
  // Slack alerts for this agent, [{installation_id, channel_id|null}] = those
  // exact destinations (channel_id null = that install's alert channel).
  slackRoutes: jsonb('slack_routes').$type<
    { installation_id: string; channel_id: string | null }[] | null
  >(),
  autoResumeMinutes: integer('auto_resume_minutes').default(10), // auto-release human takeover after N min (null = never)
  // The owning user — always at least an admin on this agent; can't be
  // demoted, hidden, or removed until they hand ownership to someone else.
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Behavior config for template-based agents, {system_prompt, knowledge[], tone}
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
    // Semantic topic — classified once from the first inbound message
    // ("billing", "shipping", …) for routing rules + reports. null while
    // unclassified (first message pending or no LLM on the agent).
    intent: text('intent'),
    // 'ai' (classified — drift re-checks may update it), 'byo' (trusted from
    // the BYO agent's payload), 'manual' (operator override — never overwritten)
    intentSource: text('intent_source').notNull().default('ai'),
    // Throttle marker for drift re-classification — one window check per
    // conversation per 15 minutes.
    intentCheckedAt: timestamp('intent_checked_at', { withTimezone: true }),
    // CSAT: prompt sent on archive; the customer's next reply carries the
    // rating and is captured in csatScore instead of reaching the agent
    csatPending: boolean('csat_pending').notNull().default(false),
    csatScore: integer('csat_score'),
    csatAskedAt: timestamp('csat_asked_at', { withTimezone: true }),
    // Set when an operator archives — feeds CSAT timing + resolution metrics
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Snoozed until — actively-snoozed conversations hide from every queue
    // except the Snoozed view; expiry is passive (query-time comparison)
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    // Rolling agent memory: everything before summaryUpTo is folded into
    // agentSummary so the hosted agent remembers the whole conversation
    agentSummary: text('agent_summary'),
    summaryUpTo: timestamp('summary_up_to', { withTimezone: true }),
    // Unified customer record — resolved from channel identities via
    // contactForBinding; null for conversations predating contacts or those
    // whose identity never carried a matchable signal.
    contactId: uuid('contact_id').references(() => contacts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_agent_external').on(t.agentId, t.externalId),
    index('conversations_agent_state').on(t.agentId, t.state),
    index('conversations_snoozed').on(t.snoozedUntil),
    index('conversations_contact').on(t.contactId),
  ],
);

/** Unified customer record — one row per real person across channels.
 * Identities (page PSID, phone number, email visitor id) attach via
 * contact_identities; conversations carry contact_id so "same person texted
 * then emailed" is one record, not two threads. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    // Secondary identifiers — merges fold the losing contact's differing
    // email/phone here instead of discarding them; searchable like the
    // primary fields.
    altEmails: text('alt_emails').array().notNull().default([]),
    altPhones: text('alt_phones').array().notNull().default([]),
    // Lightweight labels — audiences, campaigns and filters group on these.
    tags: text('tags').array().notNull().default([]),
    // External-system ids — {system: id} e.g. {"salesforce": "003abc",
    // "shopify": "123"} — so CRM-synced people stay one Janis contact.
    externalIds: jsonb('external_ids').notNull().default({}),
    avatarUrl: text('avatar_url'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contacts_ws').on(t.workspaceId),
    index('contacts_ws_email').on(t.workspaceId, t.email),
    index('contacts_ws_phone').on(t.workspaceId, t.phone),
  ],
);

/** A person's identity on one channel — the join between a contact and the
 * (channel, platform user id) pair that channel_bindings already keys on. */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    platformUserId: text('platform_user_id').notNull(),
    // STOP/unsubscribe on this (channel, identity) — set by the inbound
    // keyword intercept; sendOutbound refuses while set.
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contact_identities_channel_user').on(t.channelId, t.platformUserId),
    index('contact_identities_contact').on(t.contactId),
  ],
);

/** Named static audiences — CSV imports and manual picks. Campaigns target
 *  a list via segment.list_id; dynamic filters stay in segment. */
export const contactLists = pgTable(
  'contact_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contact_lists_ws').on(t.workspaceId)],
);

export const contactListMembers = pgTable(
  'contact_list_members',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => contactLists.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contact_list_members_pair').on(t.listId, t.contactId)],
);

// Per-operator saved filter presets for the conversations list — the
// filters blob mirrors the query params of GET /api/conversations
// ({state, agent_id, assignee, attention, tab, query}) so a view is just a
// named bookmark for a filter combination.
export const savedViews = pgTable('saved_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  filters: jsonb('filters').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Ephemeral typing/working indicators — Postgres-backed (not in-memory) so
// the widget's /chat poll sees operator typing + agent working no matter
// which instance served the ping vs the poll under --max-instances N.
// Rows self-expire via expires_at comparisons; no sweeper needed.
export const typingState = pgTable(
  'typing_state',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['operator', 'agent'] }).notNull(),
    name: text('name'), // operator display name; null for agent working
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.kind] })],
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
    // 'hidden' = workspace member explicitly denied this agent (no access);
    // meaningless for agent-only users — remove their row instead.
    role: text('role', { enum: ['admin', 'member', 'hidden'] }),
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
    enum: ['keyword', 'failure', 'handoff_request', 'inactivity', 'custom_alert', 'auto_assign'],
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
  teamName: text('team_name'),
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

// Slack OAuth grants that completed with no Janis session (the public
// "Add to Slack" flow / Marketplace listing install). Held here until the
// installer signs in and POST /api/slack/claim binds it to their workspace.
export const slackPendingInstalls = pgTable('slack_pending_installs', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: text('team_id').notNull(),
  teamName: text('team_name'),
  botToken: text('bot_token').notNull(),
  installerSlackUserId: text('installer_slack_user_id'),
  installerUserToken: text('installer_user_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const suggestions = pgTable('suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  text: text('text').notNull(),
  // goal-steering context: what the draft is trying to achieve / what info is
  // missing — shown muted above the reply, never sent to the customer
  notes: text('notes'),
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
  kind: text('kind', {
    enum: ['messenger', 'instagram', 'whatsapp', 'webchat', 'email', 'gmail', 'outlook', 'voice', 'sms'],
  }).notNull(),
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
    kind: text('kind', { enum: ['llm_tokens', 'voice_seconds', 'voice_provision'] }).notNull(),
    // idempotency key for provider-sourced usage — 'voice:{callSid}' dedupes
    // Twilio's status-webhook retries so a call can only be billed once
    externalId: text('external_id'),
    // provider unit for non-token kinds — call seconds for voice_seconds
    quantity: integer('quantity'),
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
    // URL sources — the row's text is re-crawled from source_url on a
    // refresh_hours cadence (null = manual only, like an uploaded file).
    sourceUrl: text('source_url'),
    refreshHours: integer('refresh_hours'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_files_agent').on(t.agentId),
    index('knowledge_files_due').on(t.nextFetchAt),
  ],
);

// Public help center — operator-authored articles served unauthenticated at
// /help/:agentId. Published articles also feed the agent's knowledge context.
export const helpArticles = pgTable(
  'help_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    slug: text('slug'), // url-safe, unique per agent — /help/:agent/:slug
    category: text('category').notNull().default('General'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    body: text('body').notNull().default(''),
    status: text('status', { enum: ['draft', 'published'] }).notNull().default('draft'),
    position: integer('position').notNull().default(0),
    // Public-page reads bump this — the insights endpoint ranks by it.
    viewCount: integer('view_count').notNull().default(0),
    // search_vector is a GENERATED tsvector column (migration 0076) — not
    // declared here since drizzle can't express generated columns; queries
    // reference it via sql`search_vector`.
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('help_articles_agent').on(t.agentId),
    uniqueIndex('help_articles_slug').on(t.agentId, t.slug),
  ],
);

/** Every customer-facing help-center search — results=0 rows are the content
 *  roadmap: what customers asked for and couldn't find. */
export const helpSearchLog = pgTable(
  'help_search_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    query: text('query').notNull(),
    results: integer('results').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('help_search_log_agent').on(t.agentId, t.createdAt)],
);

/**
 * Saved regression cases for hosted agents — a transcript slice lifted from
 * a real (usually rescued) conversation plus the operator's expectation.
 * Replays run the agent pipeline in testRun mode (no tool executes, gated
 * calls are only proposed) and an LLM judge scores the reply.
 */
export const agentTests = pgTable(
  'agent_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    /** Ordered transcript turns — {role:'customer'|'agent'|'operator',text}. */
    turns: jsonb('turns').notNull().default([]),
    /** What a good reply looks like now — free text the judge checks. */
    expectation: text('expectation').notNull().default(''),
    sourceConversationId: uuid('source_conversation_id'),
    /** The customer message the test replays — deep-link target (?msg=). */
    sourceMessageId: uuid('source_message_id'),
    /** The turn right after the trigger in the source transcript — the agent's
     *  real answer or a marker like "(passed to a human teammate)". */
    originalReply: text('original_reply'),
    /** {at, passed, reason, reply, tools, model} — last replay outcome. */
    lastRun: jsonb('last_run'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_tests_agent').on(t.agentId)],
);

// Every regression-suite execution — manual, A/B candidate, or scheduled —
// lands here grouped by batch_id. test_id is NOT a FK: a deleted test's
// history stays readable (test_name snapshots the label).
export const agentTestRuns = pgTable(
  'agent_test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    testId: uuid('test_id').notNull(),
    testName: text('test_name').notNull().default(''),
    /** All rows from one suite run share this id — batch = the diffable unit. */
    batchId: uuid('batch_id').notNull(),
    kind: text('kind', { enum: ['manual', 'ab', 'scheduled'] }).notNull(),
    /** null = unrunnable (no LLM, empty reply, judge unreadable). */
    passed: boolean('passed'),
    reason: text('reason').notNull().default(''),
    reply: text('reply'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_test_runs_agent_batch').on(t.agentId, t.batchId),
    index('agent_test_runs_test').on(t.testId, t.createdAt),
  ],
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
  // when the next retry is due — the sweeper reclaims rows whose scheduled
  // attempt is overdue (the in-process setTimeout chain dies on deploy)
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
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

/**
 * Cross-instance SSE relay — every published bus event lands here tagged with
 * the publishing instance; each process tails rows newer than its cursor and
 * re-emits foreign-origin events locally. Rows are transient (sweeper prunes
 * after a few minutes).
 */
export const busEvents = pgTable('bus_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  origin: text('origin').notNull(),
  event: jsonb('event').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Operator presence — heartbeat rows replace the in-memory map so viewers are
 * visible across instances. Rows expire quickly; stale ones are ignored. */
export const viewers = pgTable(
  'viewers',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

/** Voice reply queue — outbound text waits here until the next Twilio turn
 * webhook pulls it, whichever instance handles that request. */
export const voiceQueue = pgTable('voice_queue', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Leader election for singleton background work (sweeper, Gmail poll, bus
 * pruning) — a row per lock name, claimed by the holder while unexpired. */
export const sweeperLocks = pgTable('sweeper_locks', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Cross-instance fixed-window rate-limit counters. One row per bucket key
 * (scope:identifier); the upsert in dbRateLimit is the atomic check. Rows are
 * pruned by the sweeper once reset_at has passed. */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
});

/** Audit trail — every security/billing-relevant mutation writes a row so
 *  the workspace can answer "who changed what, when" (SOC 2 prerequisite). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id'),
    userName: text('user_name'),
    action: text('action').notNull(), // 'agent.create', 'billing.connect', …
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_ws').on(t.workspaceId, t.createdAt)],
);

/** Background work units — enqueued by routes (broadcasts, campaign sends),
 *  drained by the sweeper under the leader lock so heavy/sequential work
 *  never runs inside an HTTP request. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(), // 'outbound.send', …
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('jobs_due').on(t.status, t.runAt)],
);

/** A scheduled/segmented outbound blast. The sweeper resolves recipients
 *  into campaign_sends rows + jobs; status flips draft → scheduled →
 *  sending → done. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    name: text('name').notNull(),
    text: text('text').notNull().default(''),
    subject: text('subject'),
    template: jsonb('template'), // whatsapp {name,language,body_params}
    segment: jsonb('segment').notNull().default({}), // CampaignSegment — see lib/campaigns
    // Drip steps after the base send: [{delay_minutes, text, subject?,
    // whatsapp_template?}] — each only reaches previous-step recipients who
    // haven't replied.
    steps: jsonb('steps').notNull().default([]),
    // Workspace-authored guidance for the channel's agent when it handles
    // replies to this campaign — injected into the reply prompt for
    // campaign-originated conversations.
    agentInstructions: text('agent_instructions'),
    // 'once' = resolve the segment at dispatch and finish; 'continuous' =
    // the campaign stays active and the sweeper enrolls new matching
    // contacts each tick (the unique send key dedupes).
    enrollment: text('enrollment', { enum: ['once', 'continuous'] })
      .notNull()
      .default('once'),
    // Public webhook path token — POST /enroll/:token drops a contact into
    // this campaign (event-driven enrollment: abandoned checkout, Zapier).
    enrollToken: text('enroll_token'),
    // Hard cap on total sends (all steps) — spend/volume ceiling per campaign.
    sendCap: integer('send_cap'),
    // The business outcome this campaign aims at — matches conversion_events.event.
    goal: text('goal'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: text('status', {
      enum: ['draft', 'scheduled', 'sending', 'paused', 'cancelled', 'done', 'failed'],
    })
      .notNull()
      .default('draft'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_ws').on(t.workspaceId)],
);

/** One row per campaign recipient — the analytics + suppression record. */
export const campaignSends = pgTable(
  'campaign_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    contactId: uuid('contact_id'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    recipient: text('recipient').notNull(), // phone/email/platform id
    // 0 = the base send; drip steps send as step_index 1..N.
    stepIndex: integer('step_index').notNull().default(0),
    status: text('status', {
      enum: [
        'pending',
        'sent',
        'failed',
        'skipped_opted_out',
        'skipped_suppressed',
        'skipped_frequency_cap',
        'skipped_cancelled',
      ],
    })
      .notNull()
      .default('pending'),
    error: text('error'),
    conversationId: uuid('conversation_id'),
    // Reply attribution — stamped when the recipient writes back; drip steps
    // skip replied recipients.
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    // Conversion attribution — stamped when a conversion event lands for
    // this contact; the event row holds the detail.
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('campaign_sends_campaign').on(t.campaignId, t.status),
    // Crash-safe fan-out: a partial dispatch resumes by re-inserting only
    // the recipients it never reached.
    uniqueIndex('campaign_sends_recipient').on(t.campaignId, t.stepIndex, t.recipient),
    // Frequency-cap counting: sends to this address in the trailing window.
    index('campaign_sends_ws_recipient').on(t.workspaceId, t.recipient, t.status, t.sentAt),
    // Conversion attribution: latest send for a contact.
    index('campaign_sends_contact').on(t.contactId, t.createdAt),
  ],
);

/** Business outcomes reported via POST /events/:token — purchases, signups,
 *  bookings. Linked to a campaign_send when the contact has one, so campaign
 *  stats distinguish delivery/engagement from conversion. */
export const conversionEvents = pgTable(
  'conversion_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    campaignSendId: uuid('campaign_send_id').references(() => campaignSends.id, {
      onDelete: 'set null',
    }),
    campaignId: uuid('campaign_id'),
    event: text('event').notNull(), // 'purchase', 'signup', 'booked', …
    valueCents: integer('value_cents'),
    source: text('source'), // 'api', 'zapier', 'shopify', …
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversion_events_ws').on(t.workspaceId, t.createdAt)],
);

/** Workspace → CRM sync connection (v1: HubSpot private-app token, poll on a
 *  lastmodified watermark). Contact identity anchors on
 *  contacts.external_ids so the same person stays one Janis contact. */
export const crmConnections = pgTable(
  'crm_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('hubspot'),
    credentialsEnc: text('credentials_enc').notNull(), // encryptSecret({token})
    enabled: boolean('enabled').notNull().default(true),
    // Synced contacts land in this list — the campaign audience picker
    // consumes it like any other list.
    listId: uuid('list_id').references(() => contactLists.id, { onDelete: 'set null' }),
    // Append-only activity write-back (HubSpot notes / SF Tasks). Opt-in per
    // connection — the queue fills only while this is on.
    activityWriteback: boolean('activity_writeback').notNull().default(false),
    watermark: timestamp('watermark', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    syncedCount: integer('synced_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('crm_connections_ws').on(t.workspaceId)],
);

/** Activity destined for CRM timelines — written at the moment Janis
 *  observes the event (campaign send/reply/fail, conversion, human reply,
 *  opt-out), drained by the crm.writeback job onto the CRM contact record.
 *  (contact_id, kind, ref_id) unique → retries never double-post. */
export const crmActivityQueue = pgTable(
  'crm_activity_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // campaign_sent|campaign_failed|campaign_reply|conversion|human_reply|opt_out
    refId: text('ref_id').notNull(), // campaign_send id, conversion_event id, message id…
    summary: text('summary').notNull(), // human-readable note body
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crm_activity_queue_ref').on(t.contactId, t.kind, t.refId),
    index('crm_activity_queue_pending').on(t.workspaceId, t.syncedAt),
  ],
);

/** Workspace suppression list — never-send addresses regardless of per-channel
 *  opt-out rows. Written by bounce/complaint webhooks, dead-number callbacks,
 *  or manually; checked by the send policy immediately before dispatch. */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    address: text('address').notNull(), // normalized: lowercased email / digits+ phone
    kind: text('kind').notNull().default('all'), // 'all' | 'email' | 'phone'
    reason: text('reason').notNull().default('manual'), // bounce|complaint|dead_number|manual
    source: text('source'), // which webhook/import wrote it
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('suppressions_ws_addr').on(t.workspaceId, t.address, t.kind)],
);
