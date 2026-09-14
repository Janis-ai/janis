import type { IngestEvent, IngestResponse } from '@janis/shared';

export interface JanisOptions {
  /** Agent API key (jk_live_...) */
  apiKey: string;
  /** Janis API origin, e.g. https://api.janis.ai */
  baseUrl?: string;
  /** fetch implementation override (testing, alternate runtimes) */
  fetch?: typeof fetch;
}

export interface UserRef {
  id?: string;
  name?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationState {
  state: 'active' | 'needs_human' | 'human' | 'archived';
  paused: boolean;
}

/**
 * Janis client for AI agents.
 *
 * Report conversation traffic, flag failures, request human handoff.
 * Every send() returns `paused` — when true, a human has taken over and
 * your agent should stay quiet for that conversation.
 */
export class Janis {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: JanisOptions) {
    if (!options.apiKey) throw new Error('Janis: apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.janis.ai').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** An end-user message received by your agent. */
  userMessage(conversationId: string, text: string, user?: UserRef) {
    return this.send([{ type: 'message_in', conversation_id: conversationId, text, user }]);
  }

  /** A response your agent sent to the end user. */
  agentMessage(conversationId: string, text: string, payload?: Record<string, unknown>) {
    return this.send([
      { type: 'message_out', conversation_id: conversationId, text, payload },
    ]);
  }

  /** Report that your agent failed to handle something. Triggers an alert. */
  failure(conversationId: string, reason?: string, payload?: Record<string, unknown>) {
    return this.send([
      { type: 'failure', conversation_id: conversationId, reason, payload },
    ]);
  }

  /** Explicitly request a human take over this conversation. */
  requestHuman(conversationId: string, reason?: string) {
    return this.send([
      { type: 'handoff_request', conversation_id: conversationId, reason },
    ]);
  }

  /** Fire a custom alert (e.g. 'refund_requested', 'angry_user'). */
  customAlert(conversationId: string, alertType: string, text?: string) {
    return this.send([
      { type: 'custom_alert', conversation_id: conversationId, alert_type: alertType, text },
    ]);
  }

  /** Batch-send arbitrary events. */
  async send(events: IngestEvent[]): Promise<IngestResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      throw new Error(`Janis ingest failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as IngestResponse;
  }

  /**
   * Polling fallback for agents that can't receive webhooks.
   * When paused, a human owns the conversation — stop replying.
   */
  async isPaused(conversationId: string): Promise<boolean> {
    return (await this.state(conversationId)).paused;
  }

  async state(conversationId: string): Promise<ConversationState> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/state`,
      { headers: { authorization: `Bearer ${this.apiKey}` } },
    );
    if (!res.ok) throw new Error(`Janis state check failed: HTTP ${res.status}`);
    return (await res.json()) as ConversationState;
  }
}

export default Janis;
