import type {
  AgentConfig,
  Alert,
  AlertRule,
  Agent,
  Channel,
  Conversation,
  Digest,
  HelpArticle,
  Message,
  SavedReply,
  Suggestion,
  WorkspaceUser,
} from '@janis/shared';
import type {
  agents,
  alertRules,
  alerts,
  channels,
  conversations,
  digests,
  helpArticles,
  messages,
  savedReplies,
  suggestions,
  users,
} from '../db/schema.js';
import { channelChatUrl } from './channels.js';

type Row<T> = T extends { $inferSelect: infer S } ? S : never;

const iso = (d: Date | string | null | undefined) =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** LLM keys are write-only: strip api_key, replace with a key_set marker. */
function scrubLlmKey(config: unknown): AgentConfig {
  const cfg = { ...((config ?? {}) as Record<string, unknown>) };
  const llm = cfg.llm as Record<string, unknown> | undefined;
  if (llm) cfg.llm = scrubLlmBlock(llm);
  return cfg as AgentConfig;
}

/** Same write-only contract for a bare llm block (workspace defaults). */
export function scrubLlmBlock(llm: unknown): Record<string, unknown> {
  const l = { ...((llm ?? {}) as Record<string, unknown>) };
  l.api_key = undefined;
  l.key_set = Boolean((llm as Record<string, unknown> | undefined)?.api_key);
  return l;
}

export function toAgent(row: Row<typeof agents>): Agent {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    webhook_url: row.webhookUrl,
    has_webhook_secret: Boolean(row.webhookSecret),
    hosted: row.hosted,
    auto_resume_minutes: row.autoResumeMinutes,
    slack_routes: row.slackRoutes ?? null,
    owner_user_id: row.ownerUserId ?? null,
    config: scrubLlmKey(row.config),
    last_seen_at: iso(row.lastSeenAt),
    api_key_preview: row.apiKeyPreview,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    created_at: iso(row.createdAt)!,
  };
}

export function toConversation(row: Row<typeof conversations>, openAlertCount = 0): Conversation {
  return {
    id: row.id,
    agent_id: row.agentId,
    external_id: row.externalId,
    state: row.state,
    assignee_id: row.assigneeId,
    // picture_url is a signed Meta CDN link — it stays server-side and is
    // served through /api/conversations/:id/avatar instead
    user_profile: stripPictureUrl(row.userProfile),
    has_avatar: Boolean((row.userProfile as { picture_url?: string } | null)?.picture_url),
    tags: row.tags ?? [],
    last_message_at: iso(row.lastMessageAt),
    last_message_preview: row.lastMessagePreview,
    open_alert_count: openAlertCount,
    is_starred: row.isStarred,
    is_unread: row.isUnread,
    human_since: iso(row.humanSince),
    snoozed_until: iso(row.snoozedUntil),
    csat_score: row.csatScore,
    csat_pending: row.csatPending,
    intent: row.intent,
    intent_source: row.intentSource,
    contact_id: row.contactId ?? null,
    created_at: iso(row.createdAt)!,
  };
}

function stripPictureUrl(profile: unknown): Record<string, unknown> {
  const p = { ...((profile ?? {}) as Record<string, unknown>) };
  delete p.picture_url;
  return p;
}

export function toMessage(row: Row<typeof messages>): Message {
  const flags = (row.flags ?? {}) as {
    failure?: boolean;
    help_requested?: boolean;
    custom_alert?: boolean;
    handoff_offer?: boolean;
    handoff_cancelled?: boolean;
    resolved?: boolean;
  };
  return {
    id: row.id,
    conversation_id: row.conversationId,
    direction: row.direction,
    author: row.authorId,
    text: row.text,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    flags: {
      failure: Boolean(flags.failure),
      help_requested: Boolean(flags.help_requested),
      custom_alert: Boolean(flags.custom_alert),
      handoff_offer: Boolean(flags.handoff_offer),
      handoff_cancelled: Boolean(flags.handoff_cancelled),
      resolved: Boolean(flags.resolved),
    },
    created_at: iso(row.createdAt)!,
  };
}

export function toAlert(row: Row<typeof alerts>): Alert {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    type: row.type,
    detail: row.detail,
    status: row.status,
    created_at: iso(row.createdAt)!,
  };
}

export function toAlertRule(row: Row<typeof alertRules>): AlertRule {
  const config = (row.config ?? {}) as {
    keywords?: string[];
    inactivity_minutes?: number;
    enabled?: boolean;
    assign_to?: string;
    assignees?: string[];
    tag?: string;
  };
  return {
    id: row.id,
    agent_id: row.agentId,
    kind: row.kind,
    config: {
      keywords: config.keywords,
      inactivity_minutes: config.inactivity_minutes,
      assign_to: config.assign_to,
      assignees: config.assignees,
      tag: config.tag,
      enabled: config.enabled !== false,
    },
    created_at: iso(row.createdAt)!,
  };
}

export function toChannel(row: Row<typeof channels>, agentName: string): Channel {
  const creds = (row.credentials ?? {}) as {
    page_id?: string;
    phone_number_id?: string;
    username?: string;
    phone_number?: string;
    verify_token?: string;
    via?: string;
    title?: string;
    subtitle?: string;
    greeting?: string;
    accent?: string;
    position?: 'left' | 'right';
    logo_url?: string;
    logo_padding?: number;
    logo_radius?: number;
    logo_border_width?: number;
    logo_border_color?: string;
    quick_replies?: string[];
    teaser_text?: string;
    proactive?: boolean;
    proactive_delay?: number;
    sound?: boolean;
    theme?: 'light' | 'dark' | 'auto';
    hide_powered_by?: boolean;
    show_help_link?: boolean;
    dictation?: boolean;
    identity_secret?: string;
    show_operator?: boolean;
    inbound_address?: string;
    reply_address?: string;
    email_address?: string;
    from_name?: string;
    from_address?: string;
    gmail_query?: string;
    email_filters?: {
      answer_addresses?: string[];
      list_mail?: boolean;
      sender_allow?: string[];
      sender_block?: string[];
      subject_exclude?: string[];
    };
    hosted?: boolean;
    email_domain?: string;
    email_domain_status?: string;
    email_domain_records?: {
      record?: string;
      name: string;
      type: string;
      value: string;
      ttl?: string;
      priority?: number;
      status?: string;
    }[];
    cf_connected?: boolean;
    cf_refresh_token?: string;
    mirror_address?: string;
  };
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    agent_id: row.agentId,
    agent_name: agentName,
    meta: {
      page_id: creds.page_id,
      phone_number_id: creds.phone_number_id,
      username: row.kind === 'instagram' ? creds.username : undefined,
      phone_number:
        row.kind === 'whatsapp' || row.kind === 'voice' || row.kind === 'sms'
          ? creds.phone_number
          : undefined,
      verify_token: creds.verify_token ?? '',
      via: creds.via === 'oauth' || creds.via === 'manual' ? creds.via : undefined,
      chat_url: channelChatUrl(row),
      identity_secret: row.kind === 'webchat' ? creds.identity_secret : undefined,
      hosted:
        (row.kind === 'voice' || row.kind === 'sms') && creds.hosted ? true : undefined,
      show_operator: row.kind === 'webchat' ? creds.show_operator === true : undefined,
      inbound_address: row.kind === 'email' ? creds.inbound_address : undefined,
      reply_address: row.kind === 'email' ? creds.reply_address : undefined,
      email_address: (row.kind === 'gmail' || row.kind === 'outlook') ? creds.email_address : undefined,
      from_name:
        ['email', 'gmail', 'outlook'].includes(row.kind) ? creds.from_name : undefined,
      from_address:
        ['email', 'gmail', 'outlook'].includes(row.kind) ? creds.from_address : undefined,
      email_filters:
        ['email', 'gmail', 'outlook'].includes(row.kind) ? creds.email_filters : undefined,
      email_domain: row.kind === 'email' ? creds.email_domain : undefined,
      email_domain_status: row.kind === 'email' ? creds.email_domain_status : undefined,
      email_domain_records:
        row.kind === 'email' && creds.email_domain_status !== 'verified'
          ? creds.email_domain_records
          : undefined,
      cf_connected: row.kind === 'email' && creds.cf_refresh_token ? true : undefined,
      mirror_address: row.kind === 'email' ? creds.mirror_address : undefined,
      gmail_query: row.kind === 'gmail' ? creds.gmail_query : undefined,
      branding:
        row.kind === 'webchat'
          ? {
              title: creds.title,
              subtitle: creds.subtitle,
              greeting: creds.greeting,
              accent: creds.accent,
              position: creds.position,
              logo_url: creds.logo_url,
              logo_padding: creds.logo_padding,
              logo_radius: creds.logo_radius,
              logo_border_width: creds.logo_border_width,
              logo_border_color: creds.logo_border_color,
              quick_replies: creds.quick_replies,
              teaser_text: creds.teaser_text,
              proactive: creds.proactive,
              proactive_delay: creds.proactive_delay,
              sound: creds.sound,
              theme: creds.theme,
              hide_powered_by: creds.hide_powered_by,
              show_help_link: creds.show_help_link,
              dictation: creds.dictation === true,
            }
          : undefined,
    },
    created_at: iso(row.createdAt)!,
  };
}

export function toSavedReply(row: Row<typeof savedReplies>): SavedReply {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    agent_id: row.agentId,
    created_at: iso(row.createdAt)!,
  };
}

export function toHelpArticle(row: Row<typeof helpArticles>): HelpArticle {
  return {
    id: row.id,
    agent_id: row.agentId,
    title: row.title,
    slug: row.slug,
    category: row.category,
    seo_title: row.seoTitle,
    seo_description: row.seoDescription,
    body: row.body,
    status: row.status,
    view_count: row.viewCount,
    published_at: iso(row.publishedAt),
    updated_at: iso(row.updatedAt)!,
  };
}

export function toDigest(row: Row<typeof digests>): Digest {
  return {
    id: row.id,
    period_start: iso(row.periodStart)!,
    period_end: iso(row.periodEnd)!,
    stats: row.stats as Digest['stats'],
    created_at: iso(row.createdAt)!,
  };
}

export function toSuggestion(row: Row<typeof suggestions>): Suggestion {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    text: row.text,
    notes: row.notes,
    source: row.source,
    status: row.status,
    created_at: iso(row.createdAt)!,
  };
}

export function toWorkspaceUser(
  row: Row<typeof users>,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'member',
): WorkspaceUser {
  const prefs = (row.notifyPrefs ?? {}) as { push?: boolean; email?: boolean; sound?: boolean };
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    status: 'active' as const, // overridden to 'invited' by the members list
    notify: {
      push: prefs.push !== false,
      email: prefs.email !== false,
      sound: prefs.sound !== false,
    },
    display_name: row.displayName,
    avatar_url: row.avatarUrl,
    show_identity: row.showIdentity !== false,
    created_at: row.createdAt?.toISOString(),
  };
}
