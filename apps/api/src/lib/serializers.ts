import type { Alert, AlertRule, Agent, Conversation, Message, WorkspaceUser } from '@janis/shared';
import type {
  agents,
  alertRules,
  alerts,
  conversations,
  messages,
  users,
} from '../db/schema.js';

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
    user_profile: (row.userProfile ?? {}) as Record<string, unknown>,
    tags: row.tags ?? [],
    last_message_at: iso(row.lastMessageAt),
    last_message_preview: row.lastMessagePreview,
    open_alert_count: openAlertCount,
    created_at: iso(row.createdAt)!,
  };
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

export function toWorkspaceUser(row: Row<typeof users>): WorkspaceUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
