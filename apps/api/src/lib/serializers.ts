import type {
  AgentConfig,
  Alert,
  AlertRule,
  Agent,
  Channel,
  Conversation,
  Digest,
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
  messages,
  savedReplies,
  suggestions,
  users,
} from '../db/schema.js';
import { channelChatUrl } from './channels.js';

type Row<T> = T extends { $inferSelect: infer S } ? S : never;

const iso = (d: Date | string | null | undefined) =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

export function toAgent(row: Row<typeof agents>): Agent {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    webhook_url: row.webhookUrl,
    has_webhook_secret: Boolean(row.webhookSecret),
    hosted: row.hosted,
    auto_resume_minutes: row.autoResumeMinutes,
    config: (row.config ?? {}) as AgentConfig,
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
  };
  return {
    id: row.id,
    agent_id: row.agentId,
    kind: row.kind,
    config: {
      keywords: config.keywords,
      inactivity_minutes: config.inactivity_minutes,
      enabled: config.enabled !== false,
    },
    created_at: iso(row.createdAt)!,
  };
}

export function toChannel(row: Row<typeof channels>, agentName: string): Channel {
  const creds = (row.credentials ?? {}) as {
    page_id?: string;
    phone_number_id?: string;
    verify_token?: string;
    via?: string;
    title?: string;
    subtitle?: string;
    greeting?: string;
    accent?: string;
    position?: 'left' | 'right';
    logo_url?: string;
    quick_replies?: string[];
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
      verify_token: creds.verify_token ?? '',
      via: creds.via === 'oauth' || creds.via === 'manual' ? creds.via : undefined,
      chat_url: channelChatUrl(row),
      branding:
        row.kind === 'webchat'
          ? {
              title: creds.title,
              subtitle: creds.subtitle,
              greeting: creds.greeting,
              accent: creds.accent,
              position: creds.position,
              logo_url: creds.logo_url,
              quick_replies: creds.quick_replies,
            }
          : undefined,
    },
    created_at: iso(row.createdAt)!,
  };
}

export function toSavedReply(row: Row<typeof savedReplies>): SavedReply {
  return { id: row.id, title: row.title, body: row.body, created_at: iso(row.createdAt)! };
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
    source: row.source,
    status: row.status,
    created_at: iso(row.createdAt)!,
  };
}

export function toWorkspaceUser(row: Row<typeof users>): WorkspaceUser {
  const prefs = (row.notifyPrefs ?? {}) as { push?: boolean; email?: boolean; sound?: boolean };
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    notify: {
      push: prefs.push !== false,
      email: prefs.email !== false,
      sound: prefs.sound !== false,
    },
  };
}
