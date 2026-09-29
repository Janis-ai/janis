/**
 * Wire types for the Janis ingest + webhook contract — the SDK's public API
 * surface. Defined here (rather than imported from the internal
 * @janis/shared schemas) so the published package is fully self-contained;
 * keep in sync with packages/shared/src/index.ts.
 */

/** End-user profile attached to events and webhooks. */
export interface EventUser {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  email?: string;
  phone?: string;
  channel?: string;
  channel_name?: string;
  profile_fetched_at?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ConversationState = 'active' | 'needs_human' | 'human' | 'archived';

interface EventBase {
  /** Your own conversation/user identifier; created if unseen. */
  conversation_id: string;
  /** Optional end-user profile shown to operators — later events merge fields. */
  user?: EventUser;
  /** ISO timestamp; defaults to server receive time. */
  timestamp?: string;
}

/** One event in a POST /v1/events batch. */
export type IngestEvent =
  | (EventBase & { type: 'message_in'; text: string; payload?: Record<string, unknown> })
  | (EventBase & { type: 'message_out'; text: string; payload?: Record<string, unknown> })
  | (EventBase & {
      type: 'failure';
      reason?: string;
      text?: string;
      payload?: Record<string, unknown>;
    })
  | (EventBase & { type: 'handoff_request'; reason?: string })
  | (EventBase & { type: 'handoff_offer'; reason?: string })
  | (EventBase & { type: 'handoff_cancelled'; reason?: string })
  | (EventBase & {
      type: 'custom_alert';
      alert_type: string;
      text?: string;
      payload?: Record<string, unknown>;
    });

/** Per-event result; `paused` tells the agent a human has taken over. */
export interface IngestResult {
  conversation_id: string;
  paused: boolean;
  conversation_state: ConversationState;
  alert_ids: string[];
}

export interface IngestResponse {
  results: IngestResult[];
}

/** Outbound webhook event types — Janis → agent webhook_url. */
export type OutboundWebhookType =
  | 'message.user' // hosted-channel inbound; agent should reply via /v1/events
  | 'human.takeover' // a human took over; pause for this conversation
  | 'message.human' // an operator sent a message to the end user
  | 'human.resume' // human released the conversation; agent may resume
  | 'agent.send' // operator asked the agent to deliver `text` verbatim
  | 'suggestion.request'; // operator asked for a suggested reply

export interface OutboundWebhook {
  type: OutboundWebhookType;
  /** The client's external conversation id. */
  conversation_id: string;
  janis_conversation_id: string;
  text?: string;
  operator?: { id: string; name: string };
  user?: EventUser;
  channel?: { kind: string; name: string };
  payload?: Record<string, unknown>;
  timestamp: string;
}
